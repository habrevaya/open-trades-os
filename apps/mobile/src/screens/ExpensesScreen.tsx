import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  checkExpenseDraft, formatAmount, recordExpense, todayIn, type DayExpense, type KeptReceipt,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { Button, Card, Field, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { dayHeading } from "../lib/format";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * MONEY I SPENT FOR THE COMPANY
 *
 * What the technician paid for out of their own pocket: the amount, the day,
 * what it was for, the job if there was one and a photograph of the receipt.
 * It goes into the queue like everything else, so it works in a basement, and
 * the office's answer comes back with the day: waiting, approved, or refused
 * with the reason in the office's own words. An approved one is paid back
 * through payroll with no tax taken from it.
 */
export function ExpensesScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const zone = field.session?.timezone ?? "UTC";
  const today = todayIn(zone);
  const expenses = field.view?.day.expenses ?? [];
  const jobs = [...new Map((field.view?.day.visits ?? []).map((v) => [v.jobId, v])).values()];

  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [day, setDay] = useState(today);
  const [jobId, setJobId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<KeptReceipt | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const yesterday = new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

  const photograph = async () => {
    setProblem(null);
    const result = await field.takeReceipt();
    if (result === null) return;
    if ("problem" in result) { setProblem(result.problem); return; }
    setReceipt(result);
  };

  const save = async () => {
    setSaved(false);
    const checked = checkExpenseDraft({ amount, spentOn: day, description: what, jobId }, today);
    if (!checked.ok) { setProblem(checked.reason); return; }
    setProblem(null);
    const job = jobs.find((v) => v.jobId === jobId);
    await field.perform((phone) => recordExpense(phone, {
      expenseId: Crypto.randomUUID(),
      expense: checked,
      jobNumber: job?.jobNumber ?? null,
      ...(receipt ? { receipt } : {}),
    }));
    setAmount(""); setWhat(""); setReceipt(null); setJobId(null); setDay(today);
    setSaved(true);
  };

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="Money I spent" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.soft}>
          Paid for something for the company out of your own pocket? Put it here with a photo of the receipt.
          The office pays it back with your pay, with no tax taken off it.
        </Text>

        <Card>
          <Field label="What you paid" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="42.50" />
          <Field label="What it was for" value={what} onChangeText={setWhat} placeholder="Capacitor from the supply house" />

          <Text style={type.label}>Day</Text>
          <View style={styles.chips}>
            <Button label="Today" kind={day === today ? "primary" : "secondary"} onPress={() => setDay(today)} />
            <Button label="Yesterday" kind={day === yesterday ? "primary" : "secondary"} onPress={() => setDay(yesterday)} />
          </View>
          <Text style={[type.soft, { marginTop: space.sm }]}>{dayHeading(day)}</Text>

          <Text style={[type.label, { marginTop: space.md }]}>Which job</Text>
          <View style={styles.chips}>
            <Button label="Not for a job" kind={jobId === null ? "primary" : "secondary"} onPress={() => setJobId(null)} />
            {jobs.map((v) => (
              <Button key={v.jobId} label={`Job ${v.jobNumber}, ${v.customer.name}`}
                      kind={jobId === v.jobId ? "primary" : "secondary"} onPress={() => setJobId(v.jobId)} />
            ))}
          </View>

          <View style={{ marginTop: space.md }}>
            <Button label={receipt ? "Take the photo again" : "Photograph the receipt"} kind="secondary" onPress={() => void photograph()} />
            {receipt ? <Text style={type.soft}>Receipt photo kept on this phone.</Text> : null}
          </View>

          {problem ? <Notice tone="red">{problem}</Notice> : null}
          {saved ? <Notice tone="green">Saved. It is sent when there is a signal.</Notice> : null}
          <View style={{ marginTop: space.md }}>
            <Button label="Save it" onPress={() => void save()} />
          </View>
        </Card>

        <Text style={[type.label, { marginTop: space.lg }]}>What you have put in</Text>
        {expenses.length === 0 ? <Text style={type.soft}>Nothing yet.</Text> : null}
        {expenses.map((e) => <ExpenseCard key={e.id} expense={e} />)}
      </ScrollView>
    </View>
  );
}

function ExpenseCard({ expense }: { expense: DayExpense }) {
  const standing = expense.waiting ? "Waiting to send"
    : expense.status === "approved" ? "Approved: the office will pay you back"
    : expense.status === "refused" ? "Not approved"
    : "Waiting for the office";
  return (
    <Card>
      <Text style={type.heading}>{formatAmount(expense.amount)}, {expense.description}</Text>
      <Text style={type.soft}>
        {[dayHeading(expense.spentOn), expense.jobNumber ? `Job ${expense.jobNumber}` : "Not for a job",
          expense.receipts > 0 ? "Receipt kept" : "No receipt"].join(", ")}
      </Text>
      <Text style={[type.body, expense.status === "refused" && { color: color.red }, expense.status === "approved" && { color: color.green }]}>
        {standing}
      </Text>
      {expense.status === "refused" && expense.decisionReason ? <Text style={type.soft}>{expense.decisionReason}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  chips: { gap: space.sm, marginTop: space.sm },
});
