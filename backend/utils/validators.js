// Shared input rules (used by register, Google sign-up and profile edit)
const NAME_RE = /^\p{L}[\p{L} .'-]{1,49}$/u;           // letters, spaces, . ' -
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Accepts "9876543210", "+91 98765 43210", "09876543210" → "9876543210"
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[\s()-]/g, '');
  d = d.replace(/^\+?91/, '').replace(/^0/, '');
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 72) return 'Password is too long (max 72 characters).';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

const cleanName = (n) => String(n || '').trim().replace(/\s+/g, ' ');

module.exports = { NAME_RE, USERNAME_RE, EMAIL_RE, escapeRegex, normalizePhone, validatePassword, cleanName };
