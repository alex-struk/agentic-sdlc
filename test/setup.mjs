// Loaded before the test files (`npm test` passes it to `--import`). The suite runs git against
// throwaway repositories, and git would otherwise read the machine's own configuration: a
// person's `user.name` and `user.email` let a test's commit succeed on their machine that fails
// on one with none, such as a CI runner. With the global and system configuration pointed at
// nothing, every machine runs the suite with the same git, and a test that commits without
// naming an identity fails where it is written.
import { devNull } from "node:os";

process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
