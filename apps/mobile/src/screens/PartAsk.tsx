import { useState } from "react";
import { Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { checkPartRequest, recordPartRequest, type DayVisit } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { partAskedLine } from "../lib/work";
import { Button, Field, Notice, Section } from "../components/ui";
import { space, type } from "../components/theme";

/**
 * ASKING THE OFFICE FOR A PART
 *
 * The part in the technician's own words, sent to the office's queue with no
 * signal if need be. The office orders it and puts the job on hold against the
 * order; the phone never holds the job itself. Each part already asked for is
 * listed with where it is.
 */
export function PartAskSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  const [open, setOpen] = useState(false);
  const [part, setPart] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const send = async () => {
    const checked = checkPartRequest(part, note);
    if (!checked.ok) { setProblem(checked.problem); return; }
    setProblem(null);
    await field.perform((phone) => recordPartRequest(phone.queue, {
      visitId: visit.id, requestId: Crypto.randomUUID(), part: checked.part, note: checked.note,
    }));
    setPart("");
    setNote("");
    setOpen(false);
  };

  return (
    <Section title="Parts for this job">
      {visit.partsAsked.map((a) => (
        <Text key={a.id} style={[type.body, { marginBottom: space.xs }]}>{partAskedLine(a)}</Text>
      ))}
      {!open ? (
        <Button label="Ask the office for a part" kind="secondary" onPress={() => setOpen(true)} />
      ) : (
        <View>
          <Text style={type.soft}>The office orders it and puts the job on hold until it comes in.</Text>
          <Field label="What part" value={part} onChangeText={setPart} maxLength={300} placeholder="Condenser fan motor, 1/4 hp" />
          <Field label="Anything else (optional)" value={note} onChangeText={setNote} maxLength={1000} multiline
                 placeholder="Model on the plate, how soon" />
          {problem ? <Notice tone="red">{problem}</Notice> : null}
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
            <View style={{ flex: 1 }}><Button label="Not now" kind="secondary" onPress={() => setOpen(false)} /></View>
            <View style={{ flex: 1 }}><Button label="Send to the office" onPress={() => void send()} /></View>
          </View>
        </View>
      )}
    </Section>
  );
}
