/**
 * @jest-environment ./jest/tzEnvironment.js
 * @tz Asia/Tokyo
 *
 * The write-path suite run from a device that disagrees about what DAY it is —
 * the case that catches an off-by-one-day, not just an off-by-N-hours. See
 * `./eventTimeWriteCases.ts`; the three device files assert identical literals.
 */
import { describeEventTimeWrite } from "./eventTimeWriteCases";

describeEventTimeWrite("Asia/Tokyo");
