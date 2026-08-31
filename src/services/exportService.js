const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { Parser } = require('json2csv');
const { prisma } = require('../database/connect');

const FIELDS = [
  { label: 'Username', key: 'lastKnownUsername' },
  { label: 'Discord User ID', key: 'userId' },
  { label: 'Verification Date/Time', key: 'verifiedAtDisplay' },
  { label: 'Membership Status', key: 'membershipStatusDisplay' },
  { label: 'Eligibility Status', key: 'eligibilityDisplay' },
  { label: 'Joined From', key: 'sourceServerName' },
  { label: 'Campaign', key: 'campaignName' },
];

function buildRows(campaign, members) {
  const serverNameByGuildId = new Map(campaign.requiredServers.map((s) => [s.guildId, s.name]));

  return members.map((m) => ({
    lastKnownUsername: m.lastKnownUsername || 'unknown',
    userId: m.userId,
    verifiedAtDisplay: m.firstVerifiedAt ? m.firstVerifiedAt.toISOString() : 'Never',
    membershipStatusDisplay: m.eligible ? 'Member of all required servers' : 'Missing one or more servers',
    eligibilityDisplay: m.eligible ? 'Eligible' : 'Not eligible',
    sourceServerName: serverNameByGuildId.get(m.sourceGuildId) || 'Unknown',
    campaignName: campaign.name,
  }));
}

async function getExportData(campaignId, { eligibleOnly = true } = {}) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { requiredServers: true },
  });
  if (!campaign) throw new Error('Campaign not found.');

  const members = await prisma.campaignMember.findMany({
    where: { campaignId, ...(eligibleOnly ? { eligible: true } : {}) },
    orderBy: { firstVerifiedAt: 'asc' },
  });

  return { campaign, rows: buildRows(campaign, members) };
}

function tmpFilePath(campaignName, ext) {
  const safe = campaignName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return path.join(os.tmpdir(), `${safe}-eligible-members-${Date.now()}.${ext}`);
}

async function exportToCsv(campaignId) {
  const { campaign, rows } = await getExportData(campaignId);
  const parser = new Parser({ fields: FIELDS.map((f) => ({ label: f.label, value: f.key })) });
  const csv = parser.parse(rows);
  const filePath = tmpFilePath(campaign.name, 'csv');
  fs.writeFileSync(filePath, csv, 'utf8');
  return { filePath, campaign };
}

async function exportToExcel(campaignId) {
  const { campaign, rows } = await getExportData(campaignId);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`${campaign.name} - Eligible Members`.slice(0, 31));

  sheet.columns = FIELDS.map((f) => ({ header: f.label, key: f.key, width: 26 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));

  const filePath = tmpFilePath(campaign.name, 'xlsx');
  await workbook.xlsx.writeFile(filePath);
  return { filePath, campaign };
}

async function exportToPdf(campaignId) {
  const { campaign, rows } = await getExportData(campaignId);
  const filePath = tmpFilePath(campaign.name, 'pdf');

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(16).text(`${campaign.name} — Eligible Members`, { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#555').text(`Generated ${new Date().toUTCString()}`);
    doc.moveDown(1);

    const colWidths = [110, 150, 150, 150, 90, 110];
    const startX = doc.x;
    let y = doc.y;

    doc.fontSize(9).fillColor('#000');
    FIELDS.forEach((f, i) => {
      doc.text(f.label, startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, {
        width: colWidths[i],
        continued: false,
      });
    });
    y += 16;
    doc.moveTo(startX, y).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y).stroke();
    y += 6;

    rows.forEach((row) => {
      if (y > 520) {
        doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
        y = doc.y;
      }
      FIELDS.forEach((f, i) => {
        doc.text(String(row[f.key]), startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, {
          width: colWidths[i],
        });
      });
      y += 16;
    });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { filePath, campaign };
}

module.exports = { exportToCsv, exportToExcel, exportToPdf, getExportData };
