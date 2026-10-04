import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { AssistantAnswer } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { Button, Card, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * ASK THE FIELD ASSISTANT
 *
 * A question in plain words, answered from the company's own records and
 * how-to notes: the equipment here and its history, the notes from earlier
 * visits, a part's price, how this company does a job. It says where the
 * answer came from, and says so when the records do not answer it. It needs
 * a signal, because it asks a model; nothing is queued.
 */
const EXAMPLES = [
  "When was this unit last serviced?",
  "What did the last technician write here?",
  "What do we charge for a capacitor?",
  "How do we flush a tankless heater?",
];

export function AssistantScreen({ visitId, nav }: { visitId: string | null; nav: Navigate }) {
  const field = useField();
  const visit = visitId ? field.view?.day.visits.find((v) => v.id === visitId) : undefined;
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const ask = async () => {
    if (question.trim().length < 3) return;
    setAsking(true);
    setProblem(null);
    const reply = await field.ask(question.trim(), visit?.id ?? null);
    setAsking(false);
    if ("problem" in reply) { setProblem(reply.problem); setAnswer(null); return; }
    setAnswer(reply);
  };

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="Ask" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.soft}>
          {visit ? `About ${visit.customer.name}'s job, from your company's records.` : "From your company's records."}
        </Text>
        <TextInput value={question} onChangeText={setQuestion} placeholder={EXAMPLES[0]} placeholderTextColor={color.inkFaint}
                   style={styles.input} multiline accessibilityLabel="Your question" />
        <Button label="Ask" busy={asking} disabled={question.trim().length < 3} onPress={() => void ask()} />
        {!answer && !problem ? (
          <View style={{ marginTop: space.md }}>
            {EXAMPLES.map((example) => (
              <Button key={example} label={example} kind="secondary" onPress={() => setQuestion(example)} />
            ))}
          </View>
        ) : null}
        {problem ? <Notice tone="red">{problem}</Notice> : null}
        {answer ? (
          <Card>
            <Text style={type.body}>{answer.text}</Text>
            {answer.sources.length > 0 ? (
              <Text style={[type.soft, { marginTop: space.sm }]}>From: {answer.sources.map((s) => s.title).join("; ")}</Text>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3, gap: space.sm },
  input: {
    minHeight: 80, borderWidth: 1, borderColor: color.line, borderRadius: 8, padding: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.sm, textAlignVertical: "top",
  },
});
