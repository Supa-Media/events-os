/**
 * @jest-environment ./jest/tzEnvironment.js
 * @tz America/New_York
 *
 * The write-path suite run on a device already in the event's zone — the case
 * that always looked fine, which is why the bug survived. See
 * `./eventTimeWriteCases.ts`; the three device files assert identical literals.
 */
import { describeEventTimeWrite } from "./eventTimeWriteCases";

describeEventTimeWrite("America/New_York");
