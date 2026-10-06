import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useField } from "../state/FieldProvider";
import { Button, Card } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * WHAT IS STILL ON THE PHONE
 *
 * How much is waiting, and every problem in words, each with only the choices
 * that make sense for it. Nothing leaves the phone from here except by the
 * technician choosing it: a queue that quietly drops its own failures loses
 * a day's work and reports success.
 */
export function OutboxScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const view = field.view;
  const waiting = view?.waiting ?? 0;
  const photos = view?.uploadsWaiting ?? 0;

  return (
    <View style={styles.root}>
      <Header title="Waiting to send" onBack={nav.back} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={type.body}>
          {waiting === 0 && photos === 0
            ? "Everything on this phone has reached the office."
            : `${waiting} ${waiting === 1 ? "update" : "updates"} and ${photos} ${photos === 1 ? "photo" : "photos"} are on this phone and will be sent when there is signal.`}
        </Text>
        <View style={{ marginVertical: space.lg }}>
          <Button label="Send now" onPress={() => void field.sync()} busy={field.syncing} />
        </View>
        {field.report?.error ? <Text style={[type.soft, { marginBottom: space.md }]}>Last try: {field.report.error}</Text> : null}

        {(view?.problems ?? []).map((problem) => (
          <Card key={problem.id}>
            <Text style={type.heading}>{problem.title}</Text>
            <Text style={[type.body, { marginTop: space.xs }]}>{problem.detail}</Text>
            <View style={styles.actions}>
              {problem.action === "acknowledge" ? (
                <Button label="Got it" kind="secondary" onPress={() => void field.resolve(problem, "acknowledge")} />
              ) : null}
              {problem.action === "retry" || problem.action === "retry_or_discard" ? (
                <Button label="Try again" kind="secondary" onPress={() => void field.resolve(problem, "retry")} />
              ) : null}
              {problem.action === "retry_or_discard" ? (
                <Button label="Let it go" kind="danger" onPress={() => void field.resolve(problem, "discard")} />
              ) : null}
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg },
  actions: { marginTop: space.md, gap: space.sm },
});
