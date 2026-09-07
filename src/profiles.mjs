export const STAGES = ["init","intent","archaeology","ratify","contract","derive-tests","bind-adapter",
  "calibrate","design","plan","build","verify","review-and-ship","deploy","operate","status"];

const without = (...drop) => STAGES.filter((s) => !drop.includes(s));

export const PROFILES = {
  greenfield: without("archaeology", "calibrate"),
  rebuild: [...STAGES],
  remediation: without("intent", "design"),
  feature: ["init","intent","plan","build","verify","review-and-ship","deploy","status"],
};

export function stagesFor(profile) {
  const s = PROFILES[profile];
  if (!s) throw new Error(`unknown profile: ${profile}`);
  return s;
}
