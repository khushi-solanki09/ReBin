// Approve (or revoke) a collector.   node verify_collector.js collector@email.com
//                                    node verify_collector.js collector@email.com --revoke
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Collector = require('./models/Collector');

(async () => {
  const email = (process.argv[2] || '').toLowerCase();
  const revoke = process.argv.includes('--revoke');
  if (!email) { console.log('Usage: node verify_collector.js <email> [--revoke]'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI, { family: 4 });
  const user = await User.findOne({ email, role: 'collector' });
  if (!user) { console.log('No collector with that email.'); process.exit(1); }
  const r = await Collector.updateOne({ userId: user._id }, { is_verified: !revoke });
  console.log(r.matchedCount ? `${email} is now ${revoke ? 'NOT verified' : 'verified ✅'}` : 'Collector profile not found.');
  await mongoose.disconnect();
})();
