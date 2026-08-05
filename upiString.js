/**
 * Builds an NPCI-compliant UPI deep link.
 *
 * Spec reference (UPI Linking Specification, NPCI):
 *   upi://pay?pa=<payee_vpa>&pn=<payee_name>&am=<amount>&cu=<currency>
 *            &tr=<merchant_txn_ref>&tn=<transaction_note>&mc=<merchant_category_code>
 *
 * Only pa, pn, am, cu, tr are mandatory for a merchant collect-style
 * intent; tn/mc are optional but recommended for clean display in the
 * paying app.
 */

const MANDATORY_FIELDS = ['pa', 'pn', 'am', 'cu', 'tr'];

/**
 * @param {Object} params
 * @param {string} params.payeeVpa        Merchant VPA, e.g. "business@okhdfcbank"
 * @param {string} params.payeeName       Display name shown in the paying app
 * @param {number} params.amount          Amount in rupees (e.g. 499.00) — NOT paise
 * @param {string} params.orderId         Merchant order/transaction reference (tr)
 * @param {string} [params.currency]      Defaults to INR
 * @param {string} [params.note]          Optional transaction note (tn)
 * @param {string} [params.merchantCode]  Optional MCC (mc)
 * @returns {string} fully encoded upi://pay URI
 */
function buildUpiString({
  payeeVpa,
  payeeName,
  amount,
  orderId,
  currency = 'INR',
  note,
  merchantCode,
}) {
  if (!payeeVpa || !payeeName || amount === undefined || !orderId) {
    throw new Error('buildUpiString: pa, pn, am, and tr are mandatory fields');
  }
  if (typeof amount !== 'number' || amount <= 0) {
    throw new Error('buildUpiString: amount must be a positive number');
  }

  const params = {
    pa: payeeVpa,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: currency,
    tr: orderId,
  };
  if (note) params.tn = note;
  if (merchantCode) params.mc = merchantCode;

  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return `upi://pay?${query}`;
}

/**
 * Validates that a UPI VPA has the basic handle@bank shape.
 * This is a lightweight sanity check, not a substitute for actual
 * VPA-resolution against NPCI/bank directories.
 */
function isValidVpa(vpa) {
  return typeof vpa === 'string' && /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/.test(vpa);
}

module.exports = { buildUpiString, isValidVpa, MANDATORY_FIELDS };
