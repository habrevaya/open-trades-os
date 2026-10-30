import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { CALL_OFF_CHOICES, callOffLabel, canCallOff, checkCallOff, type CallOffChoice, type DayVisit } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { Button, Field, Notice, Section } from "../components/ui";
import { color, space, type } from "../components/theme";

/**
 * CALLING THE VISIT OFF FROM THE DOOR
 *
 * Under the visit, folded until it is wanted, because it is the one thing on
 * the screen the phone cannot take back. Who called it off is chosen, never
 * assumed: the customer turning the team away, or one of the company's own
 * reasons, with "something else" asking for words. It goes into the queue like
 * everything else and is kept with no signal; the server lands it the way the
 * office's call off lands, and refuses it in words for a visit that is not on
 * today's day or that somebody already started.
 */
export function CallOffSection({ visit, zone }: { visit: DayVisit; zone: string }) {
  const field = useField();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<CallOffChoice | "">("");
  const [words, setWords] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (!canCallOff(visit, zone)) return null;

  const send = () => {
    const checked = checkCallOff(choice, words);
    if (!checked.ok) { setProblem(checked.problem); return; }
    setProblem(null);
    Alert.alert("Call off this visit?", "The office is told as soon as it sends, and the visit comes off your day.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Call it off", style: "destructive", onPress: () => {
          void field.record("visit.call_off", visit.id, checked.payload as unknown as Record<string, unknown>);
          setOpen(false);
        },
      },
    ]);
  };

  return (
    <Section title="Turned away, or cannot do it today">
      {!open ? (
        <Button label="Call off this visit" kind="secondary" onPress={() => setOpen(true)} />
      ) : (
        <View>
          <Text style={type.body}>Who called it off, and why?</Text>
          {CALL_OFF_CHOICES.map((c) => (
            <Pressable key={c.value} accessibilityRole="radio" accessibilityState={{ selected: choice === c.value }}
                       onPress={() => { setChoice(c.value); setProblem(null); }}
                       style={[styles.choice, choice === c.value && styles.chosen]}>
              <Text style={[type.body, choice === c.value && { color: "#fff" }]}>{callOffLabel(c.value)}</Text>
            </Pressable>
          ))}
          {choice ? (
            <Field label={choice === "other" ? "What happened" : choice === "turned_away" ? "What they said (optional)" : "More words (optional)"}
                   value={words} onChangeText={setWords} maxLength={500} multiline />
          ) : null}
          {problem ? <Notice tone="red">{problem}</Notice> : null}
          <View style={styles.actions}>
            <View style={{ flex: 1 }}><Button label="Not now" kind="secondary" onPress={() => setOpen(false)} /></View>
            <View style={{ flex: 1 }}><Button label="Call it off" kind="danger" onPress={send} /></View>
          </View>
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  choice: {
    minHeight: 48, justifyContent: "center", borderWidth: 1, borderColor: color.line, borderRadius: 8,
    paddingHorizontal: space.md, marginTop: space.sm, backgroundColor: color.canvas,
  },
  chosen: { backgroundColor: color.ink, borderColor: color.ink },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
});
