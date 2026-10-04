import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { formatAmount, parseAmount, type DayVisit } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { recordCashTip } from "../lib/sell";
import { Button, Card, Section } from "../components/ui";
import { color, space, type } from "../components/theme";
import type { Navigate } from "../shell/App";

/**
 * SELLING AND CLOSING ON A VISIT
 *
 * The estimates on the job (built here or sent by the office), the invoice,
 * a cash tip kept, and a question for the assistant. Each section appears
 * only when the server says this person may do what it offers, so nothing
 * is offered that the office would refuse.
 */

const waitingText = <Text style={{ color: color.amber, fontSize: 13 }}>  waiting to send</Text>;

const STATUS: Record<string, string> = {
  draft: "Not shown yet", sent: "Sent to them", viewed: "They opened it", expired: "Past its date",
  approved: "Approved", declined: "They said no", converted: "Invoiced",
};

export function SellSection({ visit, nav }: { visit: DayVisit; nav: Navigate }) {
  const field = useField();
  const abilities = field.view?.abilities;
  if (!abilities?.writeEstimates && visit.estimates.length === 0) return null;
  return (
    <Section title="Estimates">
      {visit.estimates.length === 0 ? <Text style={type.soft}>No estimates on this job yet.</Text> : null}
      {visit.estimates.map((estimate) => (
        <Card key={estimate.id}>
          <Text style={type.heading}>
            {estimate.number ? `Estimate ${estimate.number}` : "New estimate"}{estimate.title ? `: ${estimate.title}` : ""}
          </Text>
          <Text style={type.soft}>
            {STATUS[estimate.status] ?? estimate.status}
            {estimate.signerName ? `, signed by ${estimate.signerName}` : ""}
            {estimate.waiting ? waitingText : null}
          </Text>
          <Text style={type.body}>
            {estimate.options.map((o) => `${o.name} ${formatAmount(o.total)}`).join("  ·  ")}
          </Text>
          {abilities?.presentEstimates ? (
            <View style={{ marginTop: space.sm }}>
              <Button label="Show the customer" kind="secondary"
                      onPress={() => nav.push({ name: "present", visitId: visit.id, estimateId: estimate.id })} />
            </View>
          ) : null}
        </Card>
      ))}
      {abilities?.writeEstimates ? (
        <Button label="Build good, better, best" kind="secondary" onPress={() => nav.push({ name: "estimate-new", visitId: visit.id })} />
      ) : null}
    </Section>
  );
}

export function InvoiceSection({ visit, nav }: { visit: DayVisit; nav: Navigate }) {
  const field = useField();
  if (!field.view?.abilities.raiseInvoices) return null;
  const signedFor = visit.estimates.some((e) => e.status === "approved");
  const canBill = signedFor || visit.billable.length > 0;
  return (
    <Section title="Invoice">
      {visit.invoices.map((invoice) => (
        <Text key={invoice.id} style={type.body}>
          {invoice.number ? `Invoice ${invoice.number}` : "Invoice raised here"}: {formatAmount(invoice.total)},
          {" "}{invoice.status === "paid" ? "paid" : `${formatAmount(invoice.balance)} owing`}
          {invoice.waiting ? waitingText : null}
        </Text>
      ))}
      {canBill ? (
        <View style={{ marginTop: space.sm }}>
          <Button label="Raise the invoice" kind="secondary" onPress={() => nav.push({ name: "invoice", visitId: visit.id })} />
        </View>
      ) : visit.invoices.length === 0 ? (
        <Text style={type.soft}>Nothing to bill yet: add the parts used, or have the customer choose an option.</Text>
      ) : null}
    </Section>
  );
}

/**
 * Cash a customer handed the technician for themselves. It never reaches the
 * company and is not on the books; it is recorded because a tip a person
 * keeps is still pay that has to be reported, and it appears on their pay
 * statement already in their hand.
 */
export function CashTipSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  const [amount, setAmount] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const record = async () => {
    const parsed = parseAmount(amount);
    if (!parsed) { setProblem("Enter the tip, like 20 or 20.50."); return; }
    setProblem(null);
    await field.perform((phone) => recordCashTip(phone, { visitId: visit.id, amount: parsed, tipId: Crypto.randomUUID() }));
    setAmount("");
  };
  return (
    <Section title="A cash tip for you">
      <Text style={type.soft}>Kept by you. Recorded for your pay statement, where tips are reported.</Text>
      <View style={styles.row}>
        <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount"
                   placeholderTextColor={color.inkFaint} style={[styles.input, { flex: 1 }]} accessibilityLabel="Cash tip amount" />
        <View style={{ flex: 1 }}><Button label="Record tip" kind="secondary" onPress={() => void record()} /></View>
      </View>
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
      {visit.cashTips.map((tip) => (
        <Text key={tip.clientId} style={type.body}>Cash tip {formatAmount(tip.amount)}{tip.waiting ? waitingText : <Text style={type.soft}>  recorded</Text>}</Text>
      ))}
    </Section>
  );
}

export function AskSection({ visit, nav }: { visit: DayVisit; nav: Navigate }) {
  const field = useField();
  if (!field.view?.abilities.assistant) return null;
  return (
    <View style={{ marginBottom: space.lg }}>
      <Button label="Ask about this job" kind="secondary" onPress={() => nav.push({ name: "assistant", visitId: visit.id })} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: 8, paddingHorizontal: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.xs,
  },
  problem: { color: color.red, fontSize: 15, marginTop: space.xs },
});
