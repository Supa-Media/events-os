import { useEffect, useState } from "react";
import { Card, TextField } from "../ui";

/* ── Description ────────────────────────────────────────────────────────── */

export function DescriptionEditor({
  description,
  onSave,
}: {
  description: string;
  onSave: (description: string) => Promise<unknown>;
}) {
  const [local, setLocal] = useState(description);
  useEffect(() => setLocal(description), [description]);

  function save() {
    if (local !== description) onSave(local);
  }

  return (
    <Card className="mb-2">
      <TextField
        label="Description"
        value={local}
        placeholder="What is this template for?"
        onChangeText={setLocal}
        onBlur={save}
        multiline
      />
    </Card>
  );
}
