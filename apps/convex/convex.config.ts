import { defineApp } from "convex/server";
import aggregate from "@convex-dev/aggregate/convex.config.js";

const app = defineApp();
// Named instance — People-CRM persona counts (`people.ts#counts`). This is
// the app's FIRST Convex component; see `lib/peopleAggregate.ts` for the
// `TableAggregate` definition and the write-through triggers that keep it in
// sync with `people.persona`.
app.use(aggregate, { name: "peopleByPersona" });

export default app;
