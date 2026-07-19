const express = require('express');
const router = express.Router();
const { getVideoInfo, isSupportedUrl } = require('../services/ytdlp');

router.get('/', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL parameter is required' });
  }

  if (!isSupportedUrl(url)) {
    return res.status(400).json({ success: false, error: 'A valid http(s) URL is required' });
  }

  try {
    const info = await getVideoInfo(url);
    res.json({
      success: true,
      data: info,
    });
  } catch (error) {
    // getVideoInfo already logged the raw stderr for operators; error.message is
    // now friendly user-facing copy (see utils/friendlyError.js), so don't re-log it.
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
