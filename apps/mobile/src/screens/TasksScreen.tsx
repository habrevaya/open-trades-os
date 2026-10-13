import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { closePayload, closeProblem, tickPayload, type DayTask } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { Button, Card, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * THE OFFICE'S QUEUE, ON THE PHONE
 *
 * The person's own tasks and the ones nobody has taken, soonest due first.
 * Taking one and finishing one go through the queue like everything else, so
 * they work with no signal; the server decides who took it first, and the
 * second person is told somebody else has it. A task with a checklist shows its
 * items to tick one at a time, and finishing it with some unticked asks why,
 * in the office's own words.
 */
export function TasksScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const zone = field.session?.timezone ?? "UTC";
  const tasks = (field.view?.day.tasks ?? []).filter((t) => !t.done || t.waiting);

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="Tasks" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {tasks.length === 0 ? <Text style={type.soft}>Nothing in the queue for you.</Text> : null}
        {tasks.map((task) => <TaskCard key={task.id} task={task} zone={zone} />)}
      </ScrollView>
    </View>
  );
}

function TaskCard({ task, zone }: { task: DayTask; zone: string }) {
  const field = useField();
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const due = task.dueAt
    ? new Date(task.dueAt).toLocaleString("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })
    : null;
  const checklist = task.checklistTotal > 0;
  return (
    <Card>
      <Text style={type.heading}>{task.title}</Text>
      {task.body ? <Text style={type.soft}>{task.body}</Text> : null}
      <Text style={[type.soft, task.overdue && { color: color.red }]}>
        {[due ? `Due ${due}` : null, task.overdue ? "late" : null, task.mine ? "yours" : "nobody has it",
          checklist ? `${task.checklistDone} of ${task.checklistTotal} ticked` : null,
          task.waiting ? "waiting to send" : null].filter(Boolean).join(", ")}
      </Text>
      {task.done ? <Notice tone="green">Done on this phone.</Notice> : null}
      {!task.mine && !task.done ? (
        <View style={{ marginTop: space.sm }}>
          <Button label="Take it" kind="secondary" onPress={() => void field.record("task.claim", task.id)} />
        </View>
      ) : null}
      {task.mine && !task.done && checklist ? task.checklist.map((item) => (
        <View key={item.id} style={{ marginTop: space.xs }}>
          <Button kind="secondary" label={`${item.done ? "Ticked" : "Not ticked"}: ${item.label}${item.waiting ? " (waiting to send)" : ""}`}
                  onPress={() => void field.record("task.tick", task.id, tickPayload(item.id, !item.done))} />
        </View>
      )) : null}
      {task.mine && !task.done ? (
        <View style={{ marginTop: space.sm }}>
          <TextInput value={outcome} onChangeText={setOutcome} placeholder="What happened (optional)"
                     placeholderTextColor={color.inkFaint} style={styles.input} accessibilityLabel="What happened" />
          {checklist && task.checklist.some((i) => !i.done) ? (
            <TextInput value={reason} onChangeText={setReason} placeholder="Why it is done with items unticked"
                       placeholderTextColor={color.inkFaint} style={styles.input} accessibilityLabel="Why items are unticked" />
          ) : null}
          {problem ? <Notice tone="red">{problem}</Notice> : null}
          <Button label="Done" onPress={() => {
            const wrong = closeProblem(task, reason);
            setProblem(wrong);
            if (!wrong) void field.record("task.close", task.id, closePayload(task, outcome, reason));
          }} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: 8, paddingHorizontal: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.sm,
  },
});
