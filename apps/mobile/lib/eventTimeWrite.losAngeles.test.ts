/**
 * @jest-environment ./jest/tzEnvironment.js
 * @tz America/Los_Angeles
 *
 * The write-path suite run three hours behind the event — the leader whose
 * "7:00 PM" used to be stored as 10:00 PM Eastern. See
 * `./eventTimeWriteCases.ts`; the three device files assert identical literals.
 */
import { describeEventTimeWrite } from "./eventTimeWriteCases";

describeEventTimeWrite("America/Los_Angeles");
