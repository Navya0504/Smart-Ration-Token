// =================== IMPORTS ===================
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
const twilio = require('twilio');
const serviceAccount = require('./serviceAccountKey.json.json');

// =================== FIRESTORE INIT ===================
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// =================== EXPRESS INIT ===================
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// =================== TWILIO CONFIG ===================
const TWILIO_ACCOUNT_SID = 'your_account_sid_here';
const TWILIO_AUTH_TOKEN = 'your_auth_token_here';
const TWILIO_PHONE_NUMBER = 'your_twilio_phone_number_here';

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// =================== LOGIN ROUTE ===================
app.post('/login', async (req, res) => {
    const { cardNumber, name, phone } = req.body;

    if (!cardNumber || !name || !phone)
        return res.json({ success: false, message: "Please fill all details!" });

    try {
        const userRef = db.collection('users').doc(cardNumber);
        const doc = await userRef.get();

        if (!doc.exists)
            return res.json({ success: false, message: "User not registered!" });

        const userData = doc.data();

        if (userData.Name === name && userData["Phone Number"] === phone) {
            return res.json({ success: true, message: "Login successful!" });
        } else {
            return res.json({ success: false, message: "Invalid name or phone number!" });
        }

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

// =================== GOVERNMENT: SET ALLOWED DAYS ===================
app.post('/setAllowedDays', async (req, res) => {
    const { month, days } = req.body; // month: MM-YYYY, days: array of DD-MM-YYYY

    if (!month || !days || !Array.isArray(days))
        return res.json({ success: false, message: "Invalid data" });

    try {
        const docRef = db.collection('monthlyRationDays').doc(month);
        await docRef.set({ days });
        return res.json({ success: true, message: "Ration days set successfully" });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// =================== GOVERNMENT: FETCH ALLOWED DAYS ===================
app.get('/allowedDays', async (req, res) => {
    const { month } = req.query; // format: MM-YYYY

    console.log('Fetching allowed days for month:', month);

    if (!month)
        return res.json({ success: false, message: "Month not provided" });

    try {
        const docRef = db.collection('monthlyRationDays').doc(month);
        const doc = await docRef.get();

        console.log('Document exists:', doc.exists);

        if (!doc.exists)
            return res.json({ success: false, message: "Ration days not announced yet" });

        const data = doc.data();
        console.log('Data:', data);
        return res.json({ success: true, days: data.days });

    } catch (err) {
        console.error('Error fetching allowed days:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// =================== BOOKING ROUTE ===================
app.post('/book', async (req, res) => {
    const { card, date, session, slot } = req.body;

    if (!card || !date || !session || !slot)
        return res.json({ success: false, message: "Fill all details!" });

    try {
        // =================== USER CHECK ===================
        const userRef = db.collection('users').doc(card);
        const userDoc = await userRef.get();

        if (!userDoc.exists)
            return res.json({ success: false, message: "User not registered!" });

        const userData = userDoc.data();

        // =================== MONTH CALCULATION ===================
        const [year, month, day] = date.split('-'); // YYYY-MM-DD
        const monthId = `${month}-${year}`;         // MM-YYYY
        const formattedDate = `${day}-${month}-${year}`; // DD-MM-YYYY

        // =================== GOVERNMENT DATE VALIDATION ===================
        const govRef = db.collection('monthlyRationDays').doc(monthId);
        const govDoc = await govRef.get();

        if (!govDoc.exists)
            return res.json({ success: false, message: "Ration dates not announced yet" });

        const allowedDays = govDoc.data().days;

        if (!allowedDays.includes(formattedDate))
            return res.json({ success: false, message: "Date not approved by government" });

        // =================== ONE BOOKING PER MONTH CHECK ===================
        const monthlyBookingRef = userRef.collection('monthlyBookings').doc(monthId);
        const monthlyBookingDoc = await monthlyBookingRef.get();

        if (monthlyBookingDoc.exists)
            return res.json({
                success: false,
                message: "You have already booked a ration slot for this month"
            });

        // =================== SLOT COUNT CHECK ===================
        const slotRef = db.collection('bookings')
            .doc(`${date}-${session}-${slot}`);

        const slotDoc = await slotRef.get();
        const slotCount = slotDoc.exists ? slotDoc.data().count : 0;

        if (slotCount >= 10)
            return res.json({ success: false, message: "Slot is full!" });

        // =================== TOKEN GENERATION ===================
        const monthlyTokenRef = db.collection('monthlyTokens')
            .doc(monthId);

        const monthlyTokenDoc = await monthlyTokenRef.get();
        const tokenCounter = monthlyTokenDoc.exists ? monthlyTokenDoc.data().tokenCounter : 0;
        const tokenNumber = tokenCounter + 1;

        // =================== SAVE BOOKING ===================
        await slotRef.set({
            count: slotCount + 1,
            date,
            session,
            slot
        }, { merge: true });

        await monthlyTokenRef.set({
            tokenCounter: tokenNumber,
            month: monthId
        }, { merge: true });

        await monthlyBookingRef.set({
            date,
            session,
            slot,
            token: tokenNumber,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // =================== SEND SMS ===================
        const messageBody =
            `Hello ${userData.Name},\n` +
            `Your ration booking is confirmed.\n` +
            `Date: ${formattedDate}\n` +
            `Session: ${session}\n` +
            `Slot: ${slot}\n` +
            `Token Number: ${tokenNumber}`;

        try {
            await client.messages.create({
                body: messageBody,
                from: TWILIO_PHONE_NUMBER,
                to: `+91${userData["Phone Number"]}`
            });
        } catch (err) {
            console.log("SMS not sent (Twilio trial limitation)");
        }

        return res.json({
            success: true,
            message: "Booking confirmed successfully!",
            booking: {
                date,
                session,
                slot,
                token: tokenNumber
            }
        });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

// =================== AVAILABLE SLOTS ROUTE ===================
app.get('/availableSlots', async (req, res) => {
    const { date, session, slot } = req.query;

    if (!date || !session || !slot)
        return res.json({ success: false, count: 0 });

    try {
        const slotRef = db.collection('bookings')
            .doc(`${date}-${session}-${slot}`);
        const slotDoc = await slotRef.get();
        const count = slotDoc.exists ? slotDoc.data().count : 0;

        return res.json({ success: true, count });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, count: 0 });
    }
});

// =================== BOOKING DETAILS ===================
app.get('/bookingDetails', async (req, res) => {
    const { card, date } = req.query;

    if (!card || !date)
        return res.json({ success: false, message: "Missing data" });

    try {
        const [year, month] = date.split('-');
        const monthId = `${month}-${year}`;

        const bookingRef = db.collection('users')
            .doc(card)
            .collection('monthlyBookings')
            .doc(monthId);

        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists)
            return res.json({ success: false });

        return res.json({ success: true, booking: bookingDoc.data() });

    } catch (err) {
        console.error(err);
        return res.json({ success: false });
    }
});

// =================== FRONTEND ROUTES ===================
app.get('/', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/login', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/select', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'select.html')));

app.get('/confirm', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'confirm.html')));

// =================== START SERVER ===================
const PORT = 3000;
app.listen(PORT, () =>
    console.log(`Server running at http://localhost:${PORT}`));
