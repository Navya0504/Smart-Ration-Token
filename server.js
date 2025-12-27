// =================== IMPORTS ===================
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
const twilio = require('twilio');
const serviceAccount = require('./serviceAccountKey.json');

// =================== FIRESTORE INIT ===================
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// =================== EXPRESS INIT ===================
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve frontend files

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
        if (!doc.exists) return res.json({ success: false, message: "User not registered!" });

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

// =================== BOOKING ROUTE (with AI slot suggestion) ===================
app.post('/book', async (req, res) => {
    const { card, date, session, slot } = req.body;
    if (!card || !date || !session)
        return res.json({ success: false, message: "Fill all details!" });

    try {
        const userRef = db.collection('users').doc(card);
        const doc = await userRef.get();
        if (!doc.exists) return res.json({ success: false, message: "User not registered!" });

        const userData = doc.data();

        // =================== AI SLOT SUGGESTION ===================
        const allSlots = ["10:00-10:30","10:30-11:00","11:00-11:30","11:30-12:00"];
        let selectedSlot = slot; // if user selected, use it

        if (!slot) {
            // find least crowded slot automatically
            let slotCount = {};
            for (let s of allSlots) slotCount[s] = 0;

            const snapshot = await db.collection('bookings')
                                     .where("date", "==", date)
                                     .where("session", "==", session)
                                     .get();

            snapshot.forEach(doc => {
                const data = doc.data();
                slotCount[data.slot] = data.count || 0;
            });

            // pick slot with minimum bookings
            selectedSlot = allSlots[0];
            let minCount = slotCount[selectedSlot];
            for (let s of allSlots) {
                if (slotCount[s] < minCount) {
                    minCount = slotCount[s];
                    selectedSlot = s;
                }
            }
        }

        // =================== CHECK IF SLOT FULL ===================
        const slotRef = db.collection('bookings').doc(`${date}-${session}-${selectedSlot}`);
        const slotDoc = await slotRef.get();
        const count = slotDoc.exists ? slotDoc.data().count : 0;
        if (count >= 10) return res.json({ success: false, message: "Slot is full!" });

        const tokenNumber = Math.floor(1000 + Math.random() * 9000);

        // =================== SAVE BOOKING ===================
        await slotRef.set({ count: count + 1, date, session, slot: selectedSlot }, { merge: true });
        const userBookingRef = userRef.collection('bookedDates').doc(date);
        await userBookingRef.set({ session, slot: selectedSlot, token: tokenNumber, timing: selectedSlot });

        // =================== SEND SMS VIA TWILIO ===================
        const messageBody = `Hello ${userData.Name},\r\n` +
                            `Your booking is confirmed!\r\n` +
                            `Date: ${date}\r\n` +
                            `Session: ${session.charAt(0).toUpperCase() + session.slice(1)}\r\n` +
                            `Slot: ${selectedSlot}\r\n` +
                            `Token Number: ${tokenNumber}`;

        try {
            await client.messages.create({
                body: messageBody,
                from: TWILIO_PHONE_NUMBER,
                to: `+91${userData["Phone Number"]}`
            });

            return res.json({
                success: true,
                message: "Booking confirmed! SMS sent via Twilio.",
                booking: { date, session, slot: selectedSlot, timing: selectedSlot, token: tokenNumber }
            });

        } catch (smsError) {
            console.error("Cannot send SMS (Twilio trial error restriction):", smsError.message);
            return res.json({
                success: true,
                message: "Booking confirmed! (SMS could not be sent on trial account)",
                booking: { date, session, slot: selectedSlot, timing: selectedSlot, token: tokenNumber }
            });
        }

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

// =================== AVAILABLE SLOTS ROUTE (for AI frontend) ===================
app.get('/availableSlots', async (req, res) => {
    const { date, session, slot } = req.query;
    if (!date || !session || !slot) return res.json({ success: false, message: "Missing date, session, or slot!" });

    try {
        const slotRef = db.collection('bookings').doc(`${date}-${session}-${slot}`);
        const slotDoc = await slotRef.get();
        const count = slotDoc.exists ? slotDoc.data().count : 0;

        return res.json({ success: true, count });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, count: 0 });
    }
});

// =================== BOOKING DETAILS ROUTE FOR CONFIRM.HTML ===================
app.get('/bookingDetails', async (req, res) => {
    const { card, date } = req.query;
    if (!card || !date) return res.json({ success: false, message: "Missing card or date!" });

    try {
        const userBookingRef = db.collection('users').doc(card).collection('bookedDates').doc(date);
        const bookingDoc = await userBookingRef.get();
        if (!bookingDoc.exists) return res.json({ success: false, message: "Booking not found!" });

        const bookingData = bookingDoc.data();
        return res.json({ success: true, booking: bookingData });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

// =================== FRONTEND ROUTES ===================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/select_slot', (req, res) => res.sendFile(path.join(__dirname, 'public', 'select_slot.html')));
app.get('/confirm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirm.html')));

// =================== START SERVER ===================
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));