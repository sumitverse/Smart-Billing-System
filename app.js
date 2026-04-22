const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let currentItems = [];
const dataFile = path.join(__dirname, 'data.json');

function getReceipts() {
    if (!fs.existsSync(dataFile)) {
        return [];
    }
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return data.receipts || [];
}

function saveReceipts(receiptsArr) {
    fs.writeFileSync(dataFile, JSON.stringify({ receipts: receiptsArr }, null, 2));
}

app.get('/', (req, res) => {
    let subtotal = currentItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    let tax = subtotal * 0.10;
    let total = subtotal + tax;

    res.render('index', { 
        items: currentItems, 
        subtotal: subtotal.toFixed(2), 
        tax: tax.toFixed(2), 
        total: total.toFixed(2),
        receipts: getReceipts()
    });
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


app.post('/checkout', (req, res) => {
    if (currentItems.length === 0) {
        return res.redirect('/');
    }

    const { customerName } = req.body;

    let subtotal = currentItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    let tax = subtotal * 0.10;
    let total = subtotal + tax;

    const receiptsArr = getReceipts();
    const nextReceiptId = receiptsArr.length > 0 ? Math.max(...receiptsArr.map(r => r.id)) + 1 : 1;

    const newReceipt = {
        id: nextReceiptId,
        date: new Date().toLocaleString(),
        customerName: customerName || 'Unknown',
        items: [...currentItems],
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2)
    };

    receiptsArr.push(newReceipt);
    saveReceipts(receiptsArr);
    
    currentItems = []; // Clear Karega Current BILL

    res.redirect(`/receipt/${newReceipt.id}`);
});

// View a specific receipt
app.get('/receipt/:id', (req, res) => {
    const receiptsArr = getReceipts();
    const receipt = receiptsArr.find(r => r.id === parseInt(req.params.id, 10));
    
    if (!receipt) {
        return res.status(404).send('Receipt not found');
    }

    res.render('receipt', { receipt });
});

// Edit a specific receipt
app.get('/receipt/:id/edit', (req, res) => {
    const receiptsArr = getReceipts();
    const receipt = receiptsArr.find(r => r.id === parseInt(req.params.id, 10));
    
    if (!receipt) {
        return res.status(404).send('Receipt not found');
    }

    res.render('edit-receipt', { receipt, receipts: receiptsArr });
});

// Update a specific receipt
app.post('/receipt/:id/edit', (req, res) => {
    const receiptsArr = getReceipts();
    const receiptIndex = receiptsArr.findIndex(r => r.id === parseInt(req.params.id, 10));
    
    if (receiptIndex === -1) {
        return res.status(404).json({ error: 'Receipt not found' });
    }

    const { customerName, items } = req.body;

    if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Items must be an array' });
    }

    let subtotal = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity, 10)), 0);
    let tax = subtotal * 0.10;
    let total = subtotal + tax;

    receiptsArr[receiptIndex] = {
        ...receiptsArr[receiptIndex],
        customerName: customerName || 'Unknown',
        items: items,
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2)
    };

    saveReceipts(receiptsArr);
    
    res.json({ success: true, redirectUrl: `/receipt/${receiptsArr[receiptIndex].id}` });
});

// Customers Page
app.get('/customers', (req, res) => {
    const receiptsArr = getReceipts();
    
    // Group receipts by customerName
    const customersMap = {};
    
    receiptsArr.forEach(receipt => {
        const name = receipt.customerName;
        if (!customersMap[name]) {
            customersMap[name] = {
                name: name,
                totalSpent: 0,
                orderCount: 0,
                receipts: []
            };
        }
        customersMap[name].totalSpent += parseFloat(receipt.total);
        customersMap[name].orderCount += 1;
        customersMap[name].receipts.push(receipt);
    });

    const customers = Object.values(customersMap).sort((a, b) => b.totalSpent - a.totalSpent);

    res.render('customers', { customers, receipts: receiptsArr });
});

// Reports Page
app.get('/reports', (req, res) => {
    const receiptsArr = getReceipts();
    
    let todayTotal = 0;
    let weekTotal = 0;
    let monthTotal = 0;
    let yearTotal = 0;
    
    const now = new Date();
    
    receiptsArr.forEach(receipt => {
        let dateStr = receipt.date;
        const rDate = new Date(dateStr);
        if (isNaN(rDate.getTime())) return;
        
        const total = parseFloat(receipt.total) || 0;
        
        // Check year
        if (rDate.getFullYear() === now.getFullYear()) {
            yearTotal += total;
            
            // Check month
            if (rDate.getMonth() === now.getMonth()) {
                monthTotal += total;
                
                // Check week (last 7 days logic for simplicity)
                const diffTime = Math.abs(now - rDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                if (diffDays <= 7) {
                    weekTotal += total;
                }
                
                // Check today
                if (rDate.getDate() === now.getDate()) {
                    todayTotal += total;
                }
            }
        }
    });

    res.render('reports', { 
        receipts: receiptsArr,
        todayTotal: todayTotal.toFixed(2),
        weekTotal: weekTotal.toFixed(2),
        monthTotal: monthTotal.toFixed(2),
        yearTotal: yearTotal.toFixed(2)
    });
});

app.listen(PORT, () => {
    console.log(`Server Chal raha hai.. 3000 me`);
});
