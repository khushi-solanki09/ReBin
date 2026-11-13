const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const Collector = require('../models/Collector');

const router = express.Router();

// ── Rate limits: slow down password guessing and mass sign-ups ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});

const {
  NAME_RE, USERNAME_RE, EMAIL_RE, escapeRegex, normalizePhone, validatePassword, cleanName
} = require('../utils/validators');

const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

const publicUser = (user) => ({
  id: user._id, name: user.name, username: user.username, email: user.email, role: user.role
});

// Fixed hash so a login for an unknown email takes as long as one for a known email
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ══════════════════════════════════════
//  REGISTER
// ══════════════════════════════════════
router.post('/register', authLimiter, async (req, res) => {
  try {
    let { name, username, email, password, phone, role } = req.body;

    name = cleanName(name);
    username = String(username || '').trim();
    email = String(email || '').trim().toLowerCase();

    if (!name || !username || !email || !password || !phone) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Name can only contain letters, spaces, . \' and -.' });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers or underscore.' });
    if (!EMAIL_RE.test(email) || email.length > 100) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });

    // Role is never "admin" from the outside; anything else becomes a normal user
    role = role === 'collector' ? 'collector' : 'user';

    // Duplicate checks (case-insensitive for email and username)
    if (await User.findOne({ email: new RegExp('^' + escapeRegex(email) + '$', 'i') })) {
      return res.status(400).json({ error: 'This email is already registered. Please log in.' });
    }
    if (await User.findOne({ phone: { $in: [cleanPhone, '+91' + cleanPhone, '+91 ' + cleanPhone] } })) {
      return res.status(400).json({ error: 'This phone number is already registered. Please log in.' });
    }
    if (await User.findOne({ username: new RegExp('^' + escapeRegex(username) + '$', 'i') })) {
      return res.status(400).json({ error: 'Username already taken.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let user;
    try {
      user = await new User({
        name, username, email, password: hashedPassword, phone: cleanPhone, role, member_since: new Date()
      }).save();
    } catch (e) {
      // Two people registering at the same instant: the database unique indexes decide
      if (e && e.code === 11000) {
        const field = Object.keys(e.keyPattern || {})[0];
        const label = field === 'phone' ? 'phone number' : field === 'username' ? 'username' : 'email';
        return res.status(400).json({ error: `This ${label} is already registered.` });
      }
      throw e;
    }

    if (role === 'collector') {
      await new Collector({
        userId: user._id,
        collectorId: Collector.generateCollectorId(name),
        is_verified: false,               // must be approved: node verify_collector.js <email>
        address: { street: '', city: '', pincode: '' }
      }).save();
    }

    res.json({ success: true, token: signToken(user), role: user.role, user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// ══════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════
router.post('/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { password, role } = req.body;

    if (!email || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: new RegExp('^' + escapeRegex(email) + '$', 'i') });
    // Same message and similar timing whether the email exists or not
    const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !isMatch) return res.status(400).json({ error: 'Invalid email or password.' });

    // Safe to tell now: the person proved they own this account
    if (role && user.role !== role) {
      return res.status(400).json({ error: `This account is registered as a ${user.role}, not a ${role}.` });
    }

    res.json({ success: true, token: signToken(user), role: user.role, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// ══════════════════════════════════════
//  GOOGLE SIGN-IN
// ══════════════════════════════════════
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// The frontend asks for the client id here, so it is not hard-coded in the HTML
router.get('/google-config', (req, res) => res.json({ clientId: GOOGLE_CLIENT_ID || null }));

async function uniqueUsername(base) {
  let root = String(base || 'user').replace(/[^A-Za-z0-9_]/g, '').slice(0, 14);
  if (root.length < 3) root = (root + 'user').slice(0, 14);
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? root : root + crypto.randomInt(100, 9999);
    if (!(await User.findOne({ username: new RegExp('^' + escapeRegex(candidate) + '$', 'i') }))) return candidate;
  }
  return root + Date.now().toString().slice(-6);
}

router.post('/google', authLimiter, async (req, res) => {
  try {
    if (!googleClient) return res.status(503).json({ error: 'Google login is not set up on this server.' });
    const { credential } = req.body;
    const role = req.body.role === 'collector' ? 'collector' : 'user';
    if (!credential || typeof credential !== 'string') return res.status(400).json({ error: 'Missing Google credential.' });

    // Google signs this token; verifyIdToken checks signature, expiry and that it was issued for OUR client id
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
    if (!payload || !payload.email || !payload.email_verified) {
      return res.status(401).json({ error: 'Your Google email is not verified.' });
    }

    const email = payload.email.toLowerCase();
    const googleId = payload.sub;

    let user = await User.findOne({ googleId });
    if (!user) user = await User.findOne({ email: new RegExp('^' + escapeRegex(email) + '$', 'i') });

    if (user) {
      if (user.googleId && user.googleId !== googleId) {
        return res.status(400).json({ error: 'This email is linked to a different Google account.' });
      }
      if (!user.googleId) { user.googleId = googleId; await user.save(); }   // link existing email account
      if (user.role !== role) {
        return res.status(400).json({ error: `This account is registered as a ${user.role}, not a ${role}.` });
      }
    } else {
      let name = cleanName(payload.name || email.split('@')[0]);
      if (!NAME_RE.test(name)) name = cleanName(name.replace(/[^\p{L} .'-]/gu, '')) || 'ReBin User';
      name = name.slice(0, 50);
      user = await new User({
        name,
        username: await uniqueUsername(email.split('@')[0]),
        email,
        googleId,
        // No password exists for Google accounts: store an unguessable random hash
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        phone: '',
        role,
        member_since: new Date()
      }).save();

      if (role === 'collector') {
        await new Collector({
          userId: user._id,
          collectorId: Collector.generateCollectorId(name),
          is_verified: false,
          address: { street: '', city: '', pincode: '' }
        }).save();
      }
    }

    res.json({
      success: true,
      token: signToken(user),
      role: user.role,
      profile_complete: !!user.phone,
      user: publicUser(user)
    });
  } catch (err) {
    console.error('Google login error:', err.message);
    res.status(500).json({ error: 'Server error during Google login.' });
  }
});

module.exports = router;
module.exports.normalizePhone = normalizePhone;
