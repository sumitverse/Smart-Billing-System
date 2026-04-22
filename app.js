require('dotenv').config({ override: true });
const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.locals.formatCurrency = function(amount) {
    const num = parseFloat(amount);
    if (isNaN(num)) return amount;
    return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smartbilling')
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

const receiptSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    date: { type: String, required: true },
    customerName: { type: String, required: true },
    customerEmail: { type: String },
    items: { type: Array, default: [] },
    subtotal: { type: String, required: true },
    tax: { type: String, required: true },
    total: { type: String, required: true },
    status: { type: String, enum: ['Unpaid', 'Paid'], default: 'Unpaid' }
});

const Receipt = mongoose.model('Receipt', receiptSchema);

const dataFile = path.join(__dirname, 'data.json');
async function migrateData() {
    try {
        const count = await Receipt.countDocuments();
        if (count === 0 && fs.existsSync(dataFile)) {
            console.log('Migrating data from data.json to MongoDB...');
            const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            if (data.receipts && data.receipts.length > 0) {
                
                const formattedReceipts = data.receipts.map(r => ({
                    ...r,
                    status: 'Unpaid',
                    customerEmail: r.customerEmail || ''
                }));
                await Receipt.insertMany(formattedReceipts);
                console.log('Migration completed successfully.');
            }
        }
    } catch (err) {
        console.error('Data migration failed:', err);
    }
}
migrateData();

let currentItems = [];

app.get('/', async (req, res) => {
    let subtotal = currentItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    let tax = subtotal * 0.10;
    let total = subtotal + tax;

    try {
        const receipts = await Receipt.find().sort({ id: -1 }).lean();
        let unpaidTotal = 0;
        receipts.forEach(receipt => {
            if (receipt.status === 'Unpaid') {
                unpaidTotal += parseFloat(receipt.total) || 0;
            }
        });

        res.render('index', { 
            items: currentItems, 
            subtotal: subtotal.toFixed(2), 
            tax: tax.toFixed(2), 
            total: total.toFixed(2),
            receipts: receipts,
            unpaidTotal: unpaidTotal
        });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.post('/add-item', (req, res) => {
    const { itemName, price, quantity } = req.body;
    
    if (itemName && price && quantity) {
        currentItems.push({
            id: Date.now().toString(),
            name: itemName,
            price: parseFloat(price),
            quantity: parseInt(quantity, 10)
        });
    }
    
    res.redirect('/');
});

app.post('/remove-item/:id', (req, res) => {
    const itemId = req.params.id;
    currentItems = currentItems.filter(item => item.id !== itemId);
    res.redirect('/');
});

app.post('/checkout', async (req, res) => {
    if (currentItems.length === 0) {
        return res.redirect('/');
    }

    const { customerName, customerEmail } = req.body;

    let subtotal = currentItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    let tax = subtotal * 0.10;
    let total = subtotal + tax;

    try {
        const lastReceipt = await Receipt.findOne().sort({ id: -1 });
        const nextReceiptId = lastReceipt ? lastReceipt.id + 1 : 1;

        const newReceipt = new Receipt({
            id: nextReceiptId,
            date: new Date().toLocaleString(),
            customerName: customerName || 'Unknown',
            customerEmail: customerEmail || '',
            items: [...currentItems],
            subtotal: subtotal.toFixed(2),
            tax: tax.toFixed(2),
            total: total.toFixed(2),
            status: 'Unpaid'
        });

        await newReceipt.save();
        currentItems = []; // Clear Current BILL

        res.redirect(`/receipt/${newReceipt.id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error during checkout');
    }
});

app.get('/receipt/:id', async (req, res) => {
    try {
        const receipt = await Receipt.findOne({ id: parseInt(req.params.id, 10) }).lean();
        const receiptsArr = await Receipt.find().sort({ id: -1 }).lean();
        
        if (!receipt) {
            return res.status(404).send('Receipt not found');
        }

        res.render('receipt', { receipt, receipts: receiptsArr });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.get('/receipt/:id/edit', async (req, res) => {
    try {
        const receipt = await Receipt.findOne({ id: parseInt(req.params.id, 10) }).lean();
        const receiptsArr = await Receipt.find().sort({ id: -1 }).lean();
        
        if (!receipt) {
            return res.status(404).send('Receipt not found');
        }

        res.render('edit-receipt', { receipt, receipts: receiptsArr });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// Update a specific receipt
app.post('/receipt/:id/edit', async (req, res) => {
    try {
        const receiptId = parseInt(req.params.id, 10);
        const receipt = await Receipt.findOne({ id: receiptId });
        
        if (!receipt) {
            return res.status(404).json({ error: 'Receipt not found' });
        }

        const { customerName, customerEmail, items } = req.body;

        if (!Array.isArray(items)) {
            return res.status(400).json({ error: 'Items must be an array' });
        }

        let subtotal = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity, 10)), 0);
        let tax = subtotal * 0.10;
        let total = subtotal + tax;

        receipt.customerName = customerName || 'Unknown';
        if (customerEmail !== undefined) {
            receipt.customerEmail = customerEmail;
        }
        receipt.items = items;
        receipt.subtotal = subtotal.toFixed(2);
        receipt.tax = tax.toFixed(2);
        receipt.total = total.toFixed(2);

        await receipt.save();
        
        res.json({ success: true, redirectUrl: `/receipt/${receiptId}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Paid or Unpaid ka Mamla
app.post('/receipt/:id/pay', async (req, res) => {
    try {
        const receiptId = parseInt(req.params.id, 10);
        const receipt = await Receipt.findOne({ id: receiptId });

        if (!receipt) {
            return res.status(404).json({ error: 'Receipt not found' });
        }

        if (receipt.status === 'Paid') {
            return res.status(400).json({ error: 'Receipt is already paid' });
        }

        receipt.status = 'Paid';
        await receipt.save();

        if (receipt.customerEmail && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            try {
                const formatCurrency = (amount) => {
                    const num = parseFloat(amount);
                    if (isNaN(num)) return amount;
                    return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
                };

                const itemsHtml = receipt.items.map(item => `
                                    <tr>
                                        <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.name}</td>
                                        <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                                        <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">₹${formatCurrency(item.price)}</td>
                                        <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-weight: 600;">₹${formatCurrency(item.price * item.quantity)}</td>
                                    </tr>
                `).join('');

                const htmlMessage = `
                <div style="font-family: 'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; padding: 40px 20px; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                        <div style="background-color: #4f46e5; padding: 30px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 1px;">sumitverse</h1>
                            <p style="color: #e0e7ff; margin: 5px 0 0 0; font-size: 14px;">Payment Receipt</p>
                        </div>
                        
                        <div style="padding: 30px;">
                            <p style="font-size: 16px; line-height: 1.5;">Hey <strong>${receipt.customerName}</strong>! 👋</p>
                            <p style="font-size: 16px; line-height: 1.5; color: #555;">
                                <strong>Payment Successful! 🎉 ₹${formatCurrency(receipt.total)} has been received. Thanks for shopping at sumitverse.</strong>
                                <br><br>
                                I'm just a developer, and your support means everything. Thanks to you, I can actually afford Pizza 🍕 tonight instead of instant noodles! You're the best. 🌍
                                <br><br>
                                Here is your receipt:
                            </p>
                            
                            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin: 25px 0;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="padding: 5px 0; color: #64748b; font-size: 14px;">Invoice Number:</td>
                                        <td style="padding: 5px 0; text-align: right; font-weight: 600;">#${receipt.id}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 5px 0; color: #64748b; font-size: 14px;">Date:</td>
                                        <td style="padding: 5px 0; text-align: right; font-weight: 600;">${receipt.date}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 5px 0; color: #64748b; font-size: 14px;">Status:</td>
                                        <td style="padding: 5px 0; text-align: right; font-weight: 600; color: #10b981;">PAID</td>
                                    </tr>
                                </table>
                            </div>

                            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                                <thead>
                                    <tr style="background-color: #f1f5f9;">
                                        <th style="padding: 12px; text-align: left; font-size: 14px; color: #475569; border-radius: 6px 0 0 6px;">Item</th>
                                        <th style="padding: 12px; text-align: center; font-size: 14px; color: #475569;">Qty</th>
                                        <th style="padding: 12px; text-align: right; font-size: 14px; color: #475569;">Price</th>
                                        <th style="padding: 12px; text-align: right; font-size: 14px; color: #475569; border-radius: 0 6px 6px 0;">Total</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${itemsHtml}
                                </tbody>
                            </table>

                            <div style="margin-top: 20px; text-align: right;">
                                <p style="margin: 5px 0; color: #64748b;">Subtotal: <strong style="color: #333;">₹${formatCurrency(receipt.subtotal)}</strong></p>
                                <p style="margin: 5px 0; color: #64748b;">Tax (10%): <strong style="color: #333;">₹${formatCurrency(receipt.tax)}</strong></p>
                                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 15px 0 15px auto; width: 250px;">
                                <p style="margin: 5px 0; font-size: 20px; color: #0f172a;">Total Paid: <strong style="color: #4f46e5;">₹${formatCurrency(receipt.total)}</strong></p>
                            </div>
                        </div>

                        <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; font-size: 14px; color: #64748b;">Got questions? Just hit reply! I'm an actual human developer, not a robot (beep boop 🤖... just kidding).</p>
                            <p style="margin: 10px 0 0 0; font-size: 12px; color: #94a3b8;">&copy; ${new Date().getFullYear()} sumitverse. Made with ❤️ and an unhealthy amount of coffee ☕.</p>
                        </div>
                    </div>
                </div>
                `;
                
                let transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        user: process.env.EMAIL_USER,
                        pass: process.env.EMAIL_PASS
                    }
                });

                let mailOptions = {
                    from: `"sumitverse" <${process.env.EMAIL_USER}>`,
                    to: receipt.customerEmail,
                    subject: `Payment Receipt - Invoice #${receipt.id} from sumitverse`,
                    html: htmlMessage,
                    text: `Hello ${receipt.customerName}, Your payment of Rs.${formatCurrency(receipt.total)} for invoice #${receipt.id} has been successfully received. Thank you for your business!`
                };

                await transporter.sendMail(mailOptions);
                console.log(`Email sent successfully to ${receipt.customerEmail}`);
            } catch (emailError) {
                console.error('Failed to send Email via Nodemailer:', emailError.message);
            }
        }

        res.json({ success: true, status: 'Paid' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.get('/customers', async (req, res) => {
    try {
        const receiptsArr = await Receipt.find().lean();
        const customersMap = {};
        
        receiptsArr.forEach(receipt => {
            const name = receipt.customerName;
            if (!customersMap[name]) {
                customersMap[name] = {
                    name: name,
                    email: receipt.customerEmail || '',
                    totalSpent: 0,
                    orderCount: 0,
                    receipts: []
                };
            }
            customersMap[name].totalSpent += parseFloat(receipt.total);
            customersMap[name].orderCount += 1;
            // Update email if newly found
            if (receipt.customerEmail && !customersMap[name].email) {
                customersMap[name].email = receipt.customerEmail;
            }
            customersMap[name].receipts.push(receipt);
        });

        const customers = Object.values(customersMap).sort((a, b) => b.totalSpent - a.totalSpent);

        res.render('customers', { customers, receipts: receiptsArr });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// Customer Delete
app.post('/customer/:name/delete', async (req, res) => {
    try {
        const customerName = req.params.name;
        await Receipt.deleteMany({ customerName: customerName });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting customer:', err);
        res.status(500).json({ error: 'Server Error' });
    }
});
app.get('/reports', async (req, res) => {
    try {
        const receiptsArr = await Receipt.find().lean();
        
        let todayTotal = 0;
        let weekTotal = 0;
        let monthTotal = 0;
        let yearTotal = 0;
        let unpaidTotal = 0;
        
        const now = new Date();
        
        receiptsArr.forEach(receipt => {
            let dateStr = receipt.date;
            let rDate = new Date(dateStr);
            if (isNaN(rDate.getTime())) {
                let parts = dateStr.split(',')[0].split('/');
                if (parts.length === 3) {
                    rDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                }
            }
            if (isNaN(rDate.getTime())) return;

            receipt.parsedYear = rDate.getFullYear();
            receipt.parsedMonth = rDate.getMonth();
            receipt.parsedDate = rDate.getDate();
            
            // Only count "Paid" receipts for accurate reports, or count all? 
            // We'll count all to preserve existing behavior, but ideally only paid.
            const total = parseFloat(receipt.total) || 0;

            if (rDate.getFullYear() === now.getFullYear()) {
                yearTotal += total;

                if (rDate.getMonth() === now.getMonth()) {
                    monthTotal += total;

                    const diffTime = Math.abs(now - rDate);
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                    if (diffDays <= 7) {
                        weekTotal += total;
                    }

                    if (rDate.getDate() === now.getDate()) {
                        todayTotal += total;
                    }
                }
            }
            if (receipt.status === 'Unpaid') {
                unpaidTotal += total;
            }
        });

        res.render('reports', { 
            receipts: receiptsArr,
            todayTotal: todayTotal.toFixed(2),
            weekTotal: weekTotal.toFixed(2),
            monthTotal: monthTotal.toFixed(2),
            yearTotal: yearTotal.toFixed(2),
            unpaidTotal: unpaidTotal.toFixed(2)
        });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Server Chal raha hai.. ${PORT} me`);
});
