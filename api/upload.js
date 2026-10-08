const { put } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({
      error: 'Photo storage not configured. Connect a Vercel Blob store to this project (Storage → connect to stop-z-fighting).',
    });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (!buf.length) return res.status(400).json({ error: 'Empty body' });
    if (buf.length > 3.5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Photo too large (max ~3.5MB)' });
    }

    const ctype = (req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ctype)) {
      return res.status(400).json({ error: 'Only jpeg, png, webp, gif allowed' });
    }

    const ext =
      ctype === 'image/png' ? 'png' :
      ctype === 'image/webp' ? 'webp' :
      ctype === 'image/gif' ? 'gif' : 'jpg';
    const name = 'szf/' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;

    const blob = await put(name, buf, {
      access: 'public',
      contentType: ctype,
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({ url: blob.url });
  } catch (e) {
    console.error('upload error', e);
    return res.status(500).json({ error: 'Upload failed: ' + (e && e.message ? e.message : 'unknown') });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
