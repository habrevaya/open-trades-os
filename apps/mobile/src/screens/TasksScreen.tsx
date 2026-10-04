import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { DayTask } from "@opentradesos/field-client";
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
 * second person is told somebody else has it. A task with a checklist is
 * finished on its own page in the office's screens, where the items are.
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
      {task.mine && !task.done && !checklist ? (
        <View style={{ marginTop: space.sm }}>
          <TextInput value={outcome} onChangeText={setOutcome} placeholder="What happened (optional)"
                     placeholderTextColor={color.inkFaint} style={styles.input} accessibilityLabel="What happened" />
          <Button label="Done" onPress={() => void field.record("task.close", task.id, outcome.trim() ? { outcome: outcome.trim() } : {})} />
        </View>
      ) : null}
      {task.mine && !task.done && checklist ? (
        <Text style={[type.soft, { marginTop: space.sm }]}>It has a checklist: tick it and finish it on the task's own page.</Text>
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
