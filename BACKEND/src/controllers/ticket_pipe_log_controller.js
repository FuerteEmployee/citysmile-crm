const TicketPipeLog = require("../models/TicketPipeLog");

const getLogs = async (req, res) => {
  try {
    let logs = await TicketPipeLog.find({}).sort({ date: -1 });

    if (logs.length < 10) {
      // Clear legacy/incomplete records and seed clean data
      await TicketPipeLog.deleteMany({});

      const seedLogs = [
        {
          from_name: "John Doe",
          to: "support@company.com",
          from_email: "john.doe@gmail.com",
          subject: "Urgent: Billing issue in subscription #20394",
          message: "Hi support, I noticed an extra charge in my statement this morning. Please reverse the transaction as soon as possible. Thanks!",
          status: "Success",
          date: new Date(Date.now() - 1000 * 60 * 15) // 15 mins ago
        },
        {
          from_name: "Sarah Jenkins",
          to: "billing@company.com",
          from_email: "sarah.j@acmetech.io",
          subject: "Invoice INV-2026-004 Payment Receipt",
          message: "Hello team, please find attached our payment receipt for the enterprise contract upgrade. Let me know when verified.",
          status: "Success",
          date: new Date(Date.now() - 1000 * 60 * 60 * 3) // 3 hours ago
        },
        {
          from_name: "Casino Royal Spam",
          to: "info@company.com",
          from_email: "promo@casinoroyal-spin.biz",
          subject: "CLAIM YOUR $500 FREE SPINS TODAY!",
          message: "Congratulations! You have been selected to claim $500 worth of free slot machine spins. Click here to claim your bonus now!",
          status: "Spam",
          date: new Date(Date.now() - 1000 * 60 * 60 * 8) // 8 hours ago
        },
        {
          from_name: "Alexander Mercer",
          to: "support@company.com",
          from_email: "a.mercer@gmail.com",
          subject: "API Integration Request: Webhooks failing in dev mode",
          message: "Hello, we are experiencing random 502 Bad Gateway responses when receiving webhooks for transaction completions. Please advise.",
          status: "Success",
          date: new Date(Date.now() - 1000 * 60 * 60 * 25) // 1 day ago
        },
        {
          from_name: "Unknown Sender",
          to: "helpdesk@company.com",
          from_email: "noreply@unverified-domain.net",
          subject: "Undelivered Mail Returned to Sender",
          message: "The mail system could not deliver the message to contact@client-domain-example.com. Reason: mailbox full.",
          status: "Blocked",
          date: new Date(Date.now() - 1000 * 60 * 60 * 32) // 1.3 days ago
        },
        {
          from_name: "Michael Chang",
          to: "jobs@company.com",
          from_email: "m.chang@careers.com",
          subject: "Application for Senior Developer Position",
          message: "Dear Hiring Team, I am submitting my resume and portfolio for the open React & Node fullstack position advertised on LinkedIn.",
          status: "Success",
          date: new Date(Date.now() - 1000 * 60 * 60 * 48) // 2 days ago
        },
        {
          from_name: "Crypto Miner Bot",
          to: "support@company.com",
          from_email: "wealth@bit-mining-pool.org",
          subject: "Passive income from automated cryptocurrency pool",
          message: "Earn up to 10% daily ROI using our secure, cloud-based bitcoin hash-rate leasing systems. Limited registration slots open.",
          status: "Spam",
          date: new Date(Date.now() - 1000 * 60 * 60 * 60) // 2.5 days ago
        },
        {
          from_name: "Emily Watson",
          to: "support@company.com",
          from_email: "emily.w@designstudios.co",
          subject: "Requesting logo style guidelines and branding assets",
          message: "Hi support team, could you send over the SVG or high-resolution PNG copies of your primary logo and secondary color palettes?",
          status: "Success",
          date: new Date(Date.now() - 1000 * 60 * 60 * 80) // 3.3 days ago
        },
        {
          from_name: "Mail Delivery Subsystem",
          to: "support@company.com",
          from_email: "mailer-daemon@googlemail.com",
          subject: "Delivery Status Notification (Failure)",
          message: "Message to internal-staff-recipient@company.com failed. The email account you tried to reach does not exist.",
          status: "Failed",
          date: new Date(Date.now() - 1000 * 60 * 60 * 110) // 4.5 days ago
        },
        {
          from_name: "Robert Downey",
          to: "support@company.com",
          from_email: "robert.d@downeybuilders.com",
          subject: "Feedback on recent CRM implementation features",
          message: "Hello team, I wanted to express our absolute satisfaction with the new client estimates module you built. It works phenomenally!",
          status: "Success",
          date: new Date(Date.now() - 1000 * 60 * 60 * 140) // 5.8 days ago
        }
      ];

      await TicketPipeLog.insertMany(seedLogs);
      logs = await TicketPipeLog.find({}).sort({ date: -1 });
    }

    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLog = async (req, res) => {
  try {
    const log = await TicketPipeLog.create(req.body);
    res.status(201).json(log);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getLogs,
  createLog,
};
