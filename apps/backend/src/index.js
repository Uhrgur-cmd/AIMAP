const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const machinesRouter = require('./routes/machines');
const signalsRouter = require('./routes/signals');
const datamodelRouter = require('./routes/datamodel');
const mappingsRouter = require('./routes/mappings');

const app = express();
const PORT = process.env.PORT || 3050;

app.use(cors());
app.use(morgan('short'));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', process.env.UPLOAD_PATH || 'uploads')));

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.use('/api/machines', machinesRouter);
app.use('/api/signals', signalsRouter);
app.use('/api/datamodel', datamodelRouter);
app.use('/api/mappings', mappingsRouter);

app.listen(PORT, () => {
  console.log(`CT-Gate Backend running on port ${PORT}`);
});
