// Single source of truth for reward prices. The client only sends a reward id.
// Keep in sync with REWARDS in frontend/points.html (display only).
module.exports = {
  r1: { name: '10% Off at GreenMart', pts: 20 },
  r2: { name: 'Free Eco Water Bottle', pts: 30 },
  r3: { name: '20% Off Organic Grocery', pts: 50 },
  r4: { name: 'Plant a Tree in Your Name', pts: 40 },
  r5: { name: '15% Off ReBin Store', pts: 25 },
  r6: { name: 'Free Solar Charger', pts: 80 }
};
