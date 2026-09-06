const router = require("express").Router();
const applications = new Map();

router.post("/applications", (req, res) => {
  const applicant = req.body.applicant;
  if (!applicant || applicant.age < 19) {
    return res.status(400).json({ error: "applicant must be at least 19" });
  }

  const record = { id: String(applications.size + 1), applicant, fee: feeFor(applicant), status: "submitted" };
  applications.set(record.id, record);
  res.status(201).json(record);
});

router.get("/applications/:id", (req, res) => {
  const record = applications.get(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(record);
});

function feeFor(applicant) {
  return applicant.age >= 65 ? 25 : 50;
}

module.exports = router;
