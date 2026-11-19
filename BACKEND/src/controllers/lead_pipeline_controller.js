const LeadStatus = require("../models/LeadStatus");
const LeadSource = require("../models/LeadSource");

const getLeadStatuses = async (req, res) => {
  try {
    const statuses = await LeadStatus.find({}).sort({ statusorder: 1 });
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLeadStatus = async (req, res) => {
  try {
    const status = await LeadStatus.create(req.body);
    res.status(201).json(status);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLeadSources = async (req, res) => {
  try {
    const sources = await LeadSource.find({});
    res.json(sources);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLeadSource = async (req, res) => {
  try {
    const source = await LeadSource.create(req.body);
    res.status(201).json(source);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getLeadStatuses, createLeadStatus, getLeadSources, createLeadSource };
