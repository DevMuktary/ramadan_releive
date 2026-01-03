const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
require('dotenv').config();

// Initialize App & Database
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const prisma = new PrismaClient();

// --- MIDDLEWARE ---

// Security headers (Modified to allow Paystack inline scripts)
app.use(helmet({
    contentSecurityPolicy: false, 
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (CSS, Images)
app.use(express.static('public'));

// Set View Engine
app.set('view engine', 'ejs');

// Rate limiting to prevent spam
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200 // limit each IP to 200 requests per window
});
app.use(limiter);


// --- ROUTES ---

// 1. HOME PAGE
app.get('/', async (req, res) => {
    try {
        // Calculate Total Raised (Only successful payments)
        const total = await prisma.donation.aggregate({
            _sum: { amount: true },
            where: { status: 'success' }
        });

        // Get Recent 50 Donations
        const recentDonations = await prisma.donation.findMany({
            where: { status: 'success' },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        // Render the page
        res.render('index', { 
            raised: total._sum.amount || 0,
            goal: 1000000, // 1 Million Naira Goal
            donations: recentDonations,
            publicKey: process.env.PAYSTACK_PUBLIC_KEY,
            host: req.headers.host // <--- This makes the Share Button link work automatically
        });

    } catch (error) {
        console.error("Error loading home page:", error);
        res.status(500).send("System is currently under maintenance. Please check back shortly.");
    }
});

// 2. CREATE PENDING DONATION
app.post('/donate', async (req, res) => {
    const { email, amount, name, comment } = req.body;
    
    // Validation
    if(!amount || amount < 100) return res.status(400).json({error: "Minimum donation is ₦100"});
    if(!email) return res.status(400).json({error: "Email is required"});

    try {
        // Create unique reference for Paystack
        const reference = 'RAMADAN-' + Date.now() + '-' + Math.floor(Math.random() * 10000);

        // Save to DB as 'pending'
        await prisma.donation.create({
            data: {
                amount: parseFloat(amount),
                email: email,
                donorName: name || "Anonymous", // Default to Anonymous if empty
                comment: comment || null,
                reference: reference,
                status: 'pending'
            }
        });

        res.json({ reference });

    } catch (error) {
        console.error("Error creating donation:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// 3. PAYSTACK WEBHOOK (The Magic: Verifies Payment & Updates Bar)
app.post('/paystack/webhook', async (req, res) => {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        
        // 1. Verify the signature (Security check)
        const hash = crypto.createHmac('sha512', secret)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash == req.headers['x-paystack-signature']) {
            const event = req.body;
            
            // 2. Check if payment was successful
            if (event.event === 'charge.success') {
                const reference = event.data.reference;
                
                // 3. Update Database to 'success'
                // We use updateMany in case of duplicate references, though unique constraint prevents it.
                // Using standard update with try/catch is safer.
                const updatedDonation = await prisma.donation.update({
                    where: { reference: reference },
                    data: { status: 'success' }
                });

                // 4. Calculate New Total
                const total = await prisma.donation.aggregate({
                    _sum: { amount: true },
                    where: { status: 'success' }
                });

                // 5. Broadcast to all connected users (Live Update)
                io.emit('new_donation', {
                    donorName: updatedDonation.donorName,
                    amount: updatedDonation.amount,
                    comment: updatedDonation.comment,
                    totalRaised: total._sum.amount
                });
                
                console.log(`Payment Verified: ₦${updatedDonation.amount} from ${updatedDonation.donorName}`);
            }
        }
        res.sendStatus(200); // Always return 200 to Paystack
    } catch (error) {
        // Don't crash the server if webhook fails
        console.error("Webhook Error:", error.message);
        res.sendStatus(200); 
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
