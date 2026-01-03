const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const prisma = new PrismaClient();

// SECURITY CONFIGURATION
app.use(helmet({
    contentSecurityPolicy: false, // Disabled briefly to allow Paystack inline scripts
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Rate limiting to prevent spam attacks
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// 1. HOME PAGE (Fetch total & recent donations)
app.get('/', async (req, res) => {
    try {
        // Calculate total successful donations
        const total = await prisma.donation.aggregate({
            _sum: { amount: true },
            where: { status: 'success' }
        });

        // Get recent 20 donations
        const recentDonations = await prisma.donation.findMany({
            where: { status: 'success' },
            orderBy: { createdAt: 'desc' },
            take: 20
        });

        res.render('index', { 
            raised: total._sum.amount || 0,
            goal: 1000000, // 1 Million Naira Goal
            donations: recentDonations,
            publicKey: process.env.PAYSTACK_PUBLIC_KEY
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading fundraising data.");
    }
});

// 2. INITIALIZE PAYMENT (Create pending record)
app.post('/donate', async (req, res) => {
    const { email, amount, name, comment } = req.body;
    
    // Simple validation
    if(!amount || amount < 100) return res.status(400).json({error: "Minimum donation is ₦100"});

    try {
        // Create unique reference
        const reference = 'REF-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

        await prisma.donation.create({
            data: {
                amount: parseFloat(amount),
                email: email,
                donorName: name || "Anonymous",
                comment: comment,
                reference: reference,
                status: 'pending'
            }
        });

        res.json({ reference });
    } catch (error) {
        res.status(500).json({ error: "Database error" });
    }
});

// 3. PAYSTACK WEBHOOK (The Secure Verification)
app.post('/paystack/webhook', async (req, res) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');

    if (hash == req.headers['x-paystack-signature']) {
        const event = req.body;
        
        if (event.event === 'charge.success') {
            const reference = event.data.reference;
            
            // Update Database
            const updatedDonation = await prisma.donation.update({
                where: { reference: reference },
                data: { status: 'success' }
            });

            // LIVE UPDATE: Tell everyone looking at the website!
            io.emit('new_donation', {
                donorName: updatedDonation.donorName,
                amount: updatedDonation.amount,
                comment: updatedDonation.comment,
                totalRaised: (await prisma.donation.aggregate({ _sum: { amount: true }, where: { status: 'success' }}))._sum.amount
            });
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
