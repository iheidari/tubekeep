const express = require('express');
const router = express.Router();
const { getDiskUsage, DISK_SIZE_MULTIPLIER, DISK_HEADROOM_BYTES } = require('../utils/storage');

// Server disk usage for the filesystem holding downloadsDir. The frontend uses
// `free`/`used`/`total` for the format-screen banner and reads the fit knobs
// (sizeMultiplier/headroomBytes) so its "won't fit" disable-check matches the
// backend's pre-download hard-block exactly.
router.get('/', async (_req, res) => {
  try {
    const { total, free, used } = await getDiskUsage();
    res.json({
      success: true,
      data: {
        total,
        free,
        used,
        sizeMultiplier: DISK_SIZE_MULTIPLIER,
        headroomBytes: DISK_HEADROOM_BYTES,
      },
    });
  } catch (error) {
    console.error('❌ Disk usage error:', error);
    res.status(500).json({ success: false, error: 'Failed to read disk usage' });
  }
});

module.exports = router;
