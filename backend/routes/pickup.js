const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const User = require('../models/User');
const Collector = require('../models/Collector');
const Pickup = require('../models/Pickup');
const Activity = require('../models/Activity');
const { geocodeAddress } = require('../utils/geocode');

const router = express.Router();

const MAX_WEIGHT_KG = 1000;
const MAX_MONEY = 100000;
const MAX_OTP_ATTEMPTS = 5;
const POINTS_PER_KG = 10;

// ── Image upload: only real images, random server-chosen filename ──
const ALLOWED_IMAGES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ALLOWED_IMAGES[file.mimetype])
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGES[file.mimetype]) return cb(null, true);
    cb(new Error('Only JPG, PNG or WEBP images are allowed.'));
  }
});

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Finds the Collector profile for the logged-in user (must be verified)
async function getVerifiedCollector(userId) {
  const collector = await Collector.findOne({ userId });
  if (!collector) return { error: 'Collector profile not found', code: 404 };
  if (!collector.is_verified) return { error: 'Your collector account is not verified yet.', code: 403 };
  return { collector };
}

// ══════════════════════════════════════
//  CREATE PICKUP REQUEST (user)
// ══════════════════════════════════════
router.post('/pickup', auth, requireRole('user'), async (req, res) => {
  try {
    const { items, pickup_date, pickup_time, pickup_location, locationAddress, lat, lng } = req.body;

    // The collector needs a number to reach the customer (Google sign-ups start without one)
    const owner = await User.findById(req.userId).select('phone');
    if (!owner || !owner.phone) {
      return res.status(400).json({ error: 'Please add your phone number in your profile before booking a pickup.' });
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res.status(400).json({ error: 'Cart is empty or too large' });
    }
    for (const it of items) {
      const kg = Number(it && it.kg);
      if (!it || typeof it.name !== 'string' || !Number.isFinite(kg) || kg <= 0 || kg > MAX_WEIGHT_KG) {
        return res.status(400).json({ error: 'Invalid item in cart' });
      }
    }

    let resolvedLat = lat ? parseFloat(lat) : null;
    let resolvedLng = lng ? parseFloat(lng) : null;
    const resolvedAddress = String(locationAddress || pickup_location || '').slice(0, 300);

    if (!resolvedLat && resolvedAddress) {
      try {
        const geo = await geocodeAddress(resolvedAddress + ', India');
        if (geo) { resolvedLat = geo.lat; resolvedLng = geo.lng; }
      } catch (geoErr) {
        console.warn('Geocoding skipped:', geoErr.message);
      }
    }

    const pickup = new Pickup({
      userId: req.userId,
      items: items.map(i => ({ name: String(i.name).slice(0, 40), kg: Number(i.kg) })),
      pickup_date: pickup_date || new Date().toISOString().split('T')[0],
      pickup_time: pickup_time || '10:00',
      pickup_location: {
        address: resolvedAddress,
        lat: resolvedLat,
        lng: resolvedLng,
        type: resolvedLat ? 'live' : 'home'
      },
      status: 'pending'
    });

    pickup.calculateEstimate();
    await pickup.save();

    Activity.create({
      userId: req.userId,
      type: 'pickup',
      description: `Pickup request: ${pickup.total_kg} kg (${items.map(i => i.name).join(', ')})`,
      points: 0
    }).catch(e => console.warn('Activity log failed:', e.message));

    res.json({
      success: true,
      pickupId: pickup._id,
      status: pickup.status,
      total_kg: pickup.total_kg,
      estimated_value: pickup.estimated_value,
      message: 'Pickup scheduled! A collector will accept your request shortly.'
    });
  } catch (err) {
    console.error('Create pickup error:', err.message);
    res.status(500).json({ error: 'Failed to create pickup' });
  }
});

// ══════════════════════════════════════
//  GET PICKUP BY ID (owner or assigned collector only)
// ══════════════════════════════════════
router.get('/pickup/:id', auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Pickup not found' });
    const pickup = await Pickup.findById(req.params.id)
      .populate('userId', 'name phone email location addresses');
    if (!pickup) return res.status(404).json({ error: 'Pickup not found' });

    const ownerId = pickup.userId && pickup.userId._id ? pickup.userId._id.toString() : null;
    const isOwner = ownerId === req.userId;

    let collectorDoc = null;
    if (pickup.collectorId) {
      collectorDoc = await Collector.findById(pickup.collectorId).populate('userId', 'name phone');
    }
    const isAssignedCollector =
      !!collectorDoc && collectorDoc.userId && collectorDoc.userId._id.toString() === req.userId;

    // Anyone else (including other collectors) gets the same "not found"
    if (!isOwner && !isAssignedCollector) {
      return res.status(404).json({ error: 'Pickup not found' });
    }

    const out = {
      pickup: {
        id: pickup._id,
        items: pickup.items,
        total_kg: pickup.total_kg,
        estimated_value: pickup.estimated_value,
        pickup_date: pickup.pickup_date,
        pickup_time: pickup.pickup_time,
        pickup_location: pickup.pickup_location,
        status: pickup.status,
        // Only the customer sees the OTP – they read it out to the collector
        otp: isOwner ? pickup.otp : undefined,
        otp_verified: pickup.otp_verified,
        waste_image_url: pickup.waste_image_url,
        actual_weight: pickup.actual_weight,
        money_paid: pickup.money_paid,
        points_earned: pickup.points_earned,
        created_at: pickup.created_at
      },
      user: {
        name: pickup.userId.name,
        // Collector sees the customer's phone/address only after accepting
        phone: pickup.userId.phone,
        location: pickup.userId.location,
        address: pickup.userId.addresses && pickup.userId.addresses.length > 0
          ? pickup.userId.addresses.find(a => a.is_default) || pickup.userId.addresses[0]
          : null
      },
      collector: null
    };

    if (collectorDoc && collectorDoc.userId) {
      out.collector = {
        name: collectorDoc.userId.name,
        phone: collectorDoc.userId.phone,
        collectorId: collectorDoc.collectorId,
        rating: collectorDoc.rating,
        total_pickups: collectorDoc.total_pickups,
        is_active: collectorDoc.is_active,
        location: collectorDoc.location,
        address: collectorDoc.address
      };
    }

    res.json(out);
  } catch (err) {
    console.error('Get pickup error:', err.message);
    res.status(500).json({ error: 'Failed to get pickup' });
  }
});

// ══════════════════════════════════════
//  GET ALL PICKUPS FOR USER
// ══════════════════════════════════════
router.get('/pickups/user', auth, async (req, res) => {
  try {
    const pickups = await Pickup.find({ userId: req.userId })
      .populate({ path: 'collectorId', populate: { path: 'userId', select: 'name phone' } })
      .sort({ created_at: -1 })
      .limit(50);

    res.json({
      pickups: pickups.map(p => ({
        id: p._id,
        items: p.items,
        total_kg: p.total_kg,
        status: p.status,
        pickup_date: p.pickup_date,
        pickup_time: p.pickup_time,
        otp: p.otp,
        collector: p.collectorId && p.collectorId.userId ? {
          name: p.collectorId.userId.name,
          phone: p.collectorId.userId.phone,
          collectorId: p.collectorId.collectorId
        } : null,
        created_at: p.created_at
      }))
    });
  } catch (err) {
    console.error('User pickups error:', err.message);
    res.status(500).json({ error: 'Failed to get pickups' });
  }
});

// ══════════════════════════════════════
//  GET PICKUPS FOR COLLECTOR
// ══════════════════════════════════════
router.get('/pickups/collector', auth, requireRole('collector'), async (req, res) => {
  try {
    const collector = await Collector.findOne({ userId: req.userId });
    if (!collector) return res.status(404).json({ error: 'Collector not found' });

    const statusFilter = req.query.status;
    const filter = { collectorId: collector._id };
    if (statusFilter) filter.status = String(statusFilter);

    const pickups = await Pickup.find(filter)
      .populate('userId', 'name phone email location addresses')
      .sort({ created_at: -1 })
      .limit(100);

    let pendingUnassigned = [];
    if (collector.is_verified && (!statusFilter || statusFilter === 'pending')) {
      pendingUnassigned = await Pickup.find({ status: 'pending', collectorId: null })
        .populate('userId', 'name')
        .sort({ created_at: -1 })
        .limit(50);
    }

    // OTP is never sent to the collector – the customer reads it out.
    const formatAssigned = (p) => ({
      id: p._id,
      items: p.items,
      total_kg: p.total_kg,
      estimated_value: p.estimated_value,
      status: p.status,
      pickup_date: p.pickup_date,
      pickup_time: p.pickup_time,
      pickup_location: p.pickup_location,
      otp_verified: p.otp_verified,
      actual_weight: p.actual_weight,
      money_paid: p.money_paid,
      created_at: p.created_at,
      user: p.userId ? {
        name: p.userId.name,
        phone: p.userId.phone,
        location: p.userId.location,
        address: p.userId.addresses && p.userId.addresses.length > 0 ? p.userId.addresses[0] : null
      } : null
    });

    // Unaccepted requests: no phone number, no exact coordinates
    const formatNew = (p) => ({
      id: p._id,
      items: p.items,
      total_kg: p.total_kg,
      estimated_value: p.estimated_value,
      status: p.status,
      pickup_date: p.pickup_date,
      pickup_time: p.pickup_time,
      pickup_location: { address: p.pickup_location ? p.pickup_location.address : '' },
      created_at: p.created_at,
      user: p.userId ? { name: p.userId.name } : null
    });

    res.json({
      is_verified: collector.is_verified,
      assigned: pickups.map(formatAssigned),
      newRequests: pendingUnassigned.map(formatNew)
    });
  } catch (err) {
    console.error('Collector pickups error:', err.message);
    res.status(500).json({ error: 'Failed to get pickups' });
  }
});

// ══════════════════════════════════════
//  ACCEPT PICKUP (verified collector) – atomic, first one wins
// ══════════════════════════════════════
router.post('/pickup/:id/accept', auth, requireRole('collector'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Pickup not found' });
    const { collector, error, code } = await getVerifiedCollector(req.userId);
    if (error) return res.status(code).json({ error });

    const pickup = await Pickup.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', collectorId: null },
      {
        $set: {
          collectorId: collector._id,
          status: 'assigned',
          otp: Pickup.generateOTP(),
          otp_verified: false,
          otp_attempts: 0,
          updated_at: new Date()
        }
      },
      { new: true }
    );

    if (!pickup) {
      return res.status(409).json({ error: 'This pickup is no longer available.' });
    }

    const io = req.app.get('io');
    if (io) io.of('/tracking').to(`pickup-${pickup._id}`).emit('pickup:assigned');

    res.json({ success: true, message: 'Pickup accepted! Ask the customer for their OTP when you arrive.' });
  } catch (err) {
    console.error('Accept pickup error:', err.message);
    res.status(500).json({ error: 'Failed to accept pickup' });
  }
});

// ══════════════════════════════════════
//  DECLINE / RELEASE PICKUP (assigned collector only)
// ══════════════════════════════════════
router.post('/pickup/:id/decline', auth, requireRole('collector'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Pickup not found' });
    const collector = await Collector.findOne({ userId: req.userId });
    if (collector) {
      // Only an assigned (not yet verified) pickup can be released back to the pool
      await Pickup.findOneAndUpdate(
        { _id: req.params.id, collectorId: collector._id, status: 'assigned' },
        { $set: { collectorId: null, otp: null, otp_verified: false, otp_attempts: 0, status: 'pending', updated_at: new Date() } }
      );
    }
    // For unassigned requests "decline" is just dismissing the card on the collector's screen
    res.json({ success: true, message: 'Pickup declined.' });
  } catch (err) {
    console.error('Decline pickup error:', err.message);
    res.status(500).json({ error: 'Failed to decline pickup' });
  }
});

// ══════════════════════════════════════
//  VERIFY OTP (assigned collector only, limited attempts)
// ══════════════════════════════════════
router.post('/pickup/:id/verify-otp', auth, requireRole('collector'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Pickup not found' });
    const collector = await Collector.findOne({ userId: req.userId });
    if (!collector) return res.status(404).json({ error: 'Collector not found' });

    const otp = String(req.body.otp || '').trim();
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit OTP.' });

    const pickup = await Pickup.findOne({ _id: req.params.id, collectorId: collector._id, status: 'assigned' });
    if (!pickup) return res.status(404).json({ error: 'Pickup not found or not ready for verification' });

    if (pickup.otp_attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many wrong attempts. Release this pickup and ask the customer to rebook.' });
    }

    const a = Buffer.from(otp);
    const b = Buffer.from(String(pickup.otp || ''));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!ok) {
      await Pickup.updateOne({ _id: pickup._id }, { $inc: { otp_attempts: 1 } });
      return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }

    await Pickup.updateOne(
      { _id: pickup._id, status: 'assigned' },
      { $set: { otp_verified: true, status: 'in_transit', updated_at: new Date() } }
    );
    { const io = req.app.get('io'); if (io) io.of('/tracking').to(`pickup-${req.params.id}`).emit('pickup:updated'); }
    res.json({ success: true, message: 'OTP verified. You can now weigh the waste and complete the pickup.' });
  } catch (err) {
    console.error('Verify OTP error:', err.message);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// ══════════════════════════════════════
//  COMPLETE PICKUP (assigned collector, OTP already verified, only once)
// ══════════════════════════════════════
router.post('/pickup/:id/complete', auth, requireRole('collector'), (req, res, next) => {
  upload.single('waste_image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Pickup not found' });
    const collector = await Collector.findOne({ userId: req.userId });
    if (!collector) return res.status(404).json({ error: 'Collector not found' });

    const weight = Number(req.body.actual_weight);
    const money = Number(req.body.money_paid);
    if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT_KG) {
      return res.status(400).json({ error: `Weight must be between 0 and ${MAX_WEIGHT_KG} kg.` });
    }
    if (!Number.isFinite(money) || money < 0 || money > MAX_MONEY) {
      return res.status(400).json({ error: `Money paid must be between 0 and ${MAX_MONEY}.` });
    }
    if (!req.file) return res.status(400).json({ error: 'Please upload a photo of the waste.' });

    const points = Math.round(weight * POINTS_PER_KG);

    // Atomic status flip: a second request finds nothing, so points can't be awarded twice
    const pickup = await Pickup.findOneAndUpdate(
      { _id: req.params.id, collectorId: collector._id, status: 'in_transit', otp_verified: true },
      {
        $set: {
          status: 'completed',
          actual_weight: weight,
          money_paid: money,
          points_earned: points,
          waste_image_url: '/uploads/' + req.file.filename,
          updated_at: new Date()
        }
      },
      { new: true }
    );
    if (!pickup) {
      return res.status(409).json({ error: 'Pickup is not ready to complete (verify the OTP first, or it is already completed).' });
    }

    const user = await User.findByIdAndUpdate(
      pickup.userId,
      { $inc: { total_points: points, total_kg: weight } },
      { new: true }
    );
    if (user) {
      user.computeLevel();
      await user.save();
      await Activity.create({
        userId: user._id,
        type: 'earn',
        description: `Pickup completed: ${weight} kg recycled`,
        points
      });
    }

    await Collector.updateOne(
      { _id: collector._id },
      { $inc: { total_pickups: 1, total_collected_kg: weight, total_earnings: money } }
    );

    { const io = req.app.get('io'); if (io) io.of('/tracking').to(`pickup-${req.params.id}`).emit('pickup:updated'); }
    res.json({ success: true, points_earned: points, message: `Pickup completed! Customer earned +${points} points.` });
  } catch (err) {
    console.error('Complete pickup error:', err.message);
    res.status(500).json({ error: 'Failed to complete pickup' });
  }
});

module.exports = router;
