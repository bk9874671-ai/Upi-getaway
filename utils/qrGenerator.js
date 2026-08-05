const QRCode = require('qrcode');

/**
 * Generates a QR code for a UPI string in two formats:
 *   - dataUrl: base64 PNG data URL, ready for <img src="..."> embedding
 *   - svg: scalable vector markup, better for print/high-DPI display
 *
 * Error-correction level 'M' (15%) is used — a good balance for UPI
 * QRs that may be printed on receipts or displayed on small screens.
 */
async function generateUpiQr(upiString) {
  const [dataUrl, svg] = await Promise.all([
    QRCode.toDataURL(upiString, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 400,
    }),
    QRCode.toString(upiString, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
    }),
  ]);

  return { dataUrl, svg };
}

module.exports = { generateUpiQr };
