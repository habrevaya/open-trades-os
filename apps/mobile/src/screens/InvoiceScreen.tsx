import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  formatAmount, invoiceFromEstimate, invoiceFromWork, type DayEstimate,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { recordInvoice } from "../lib/sell";
import { SignatureBox } from "../components/SignatureBox";
import { Button, Card, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * THE INVOICE, ON SITE
 *
 * For the option the customer signed for, copied as signed, or for the parts
 * and charges recorded on the job, never both: an option is usually a flat
 * price that covers the parts used to do it. Shown to the customer at the
 * figure the server will write (the member's discount taken off), signed for
 * on the glass, and raised through the queue. If the office's prices turn
 * out to differ, the server keeps it as a draft for the office rather than
 * issue a figure the customer did not sign for, and the phone says so.
 */
export function InvoiceScreen({ visitId, nav }: { visitId: string; nav: Navigate }) {
  const field = useField();
  const visit = field.view?.day.visits.find((v) => v.id === visitId);
  const [source, setSource] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [stage, setStage] = useState<"choose" | "show">("choose");
  const [problem, setProblem] = useState<string | null>(null);

  if (!visit) {
    return (
      <View style={styles.root}>
        <Header onBack={nav.back} title="Invoice" />
        <Text style={[type.soft, { padding: space.lg }]}>This visit is no longer on your day.</Text>
      </View>
    );
  }

  const signedFor = visit.estimates
    .filter((e): e is DayEstimate => e.status === "approved" && (e.jobId === null || e.jobId === visit.jobId))
    .map((e) => ({ estimate: e, invoice: invoiceFromEstimate(e) }))
    .filter((x) => x.invoice !== null);
  const work = visit.billable.filter((b) => !leftOut.includes(b.id));
  const priced = invoiceFromWork(work, visit.member);
  const chosenEstimate = signedFor.find((x) => x.estimate.id === source) ?? null;
  const total = chosenEstimate ? chosenEstimate.invoice!.total : priced.totals.total;
  const nothing = signedFor.length === 0 && visit.billable.length === 0;

  const raise = async (dataUrl: string | null, signerName: string | null): Promise<string | null> => {
    let signature = null;
    if (dataUrl) {
      const kept = await field.keepDrawnSignature(dataUrl);
      if ("problem" in kept) return kept.problem;
      signature = kept;
    }
    const invoiceId = Crypto.randomUUID();
    if (chosenEstimate) {
      await field.perform((phone) => recordInvoice(phone, {
        visitId, invoiceId, shownTotal: total, signerName, signature, source: "estimate", estimateId: chosenEstimate.estimate.id,
      }));
    } else {
      if (work.length === 0) return "Nothing is left to bill.";
      await field.perform((phone) => recordInvoice(phone, {
        visitId, invoiceId, shownTotal: total, signerName, signature, source: "work", jobLineIds: work.map((w) => w.id),
      }));
    }
    nav.back();
    return null;
  };

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="Invoice" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.title}>{visit.customer.name}</Text>
        {nothing ? <Notice tone="amber">Nothing to bill yet. Add parts or charges, or have the customer choose an option.</Notice> : null}

        {stage === "choose" && !nothing ? (
          <View style={{ gap: space.sm }}>
            {signedFor.map(({ estimate, invoice }) => (
              <Pressable key={estimate.id} accessibilityRole="radio" accessibilityState={{ selected: source === estimate.id }}
                         onPress={() => setSource(estimate.id)} style={[styles.choice, source === estimate.id && styles.choiceOn]}>
                <Text style={type.heading}>The option they signed for: {invoice!.option.name}</Text>
                <Text style={type.body}>{formatAmount(invoice!.total)}, as signed{estimate.signerName ? ` by ${estimate.signerName}` : ""}</Text>
              </Pressable>
            ))}
            {visit.billable.length > 0 ? (
              <Pressable accessibilityRole="radio" accessibilityState={{ selected: source === "work" }}
                         onPress={() => setSource("work")} style={[styles.choice, source === "work" && styles.choiceOn]}>
                <Text style={type.heading}>The parts and charges recorded</Text>
                <Text style={type.body}>{formatAmount(priced.totals.total)}</Text>
              </Pressable>
            ) : null}
            {source === "work" ? visit.billable.map((b) => (
              <Button key={b.id} kind="secondary"
                      label={`${leftOut.includes(b.id) ? "Left out: " : ""}${Number(b.quantity)} x ${b.name}`}
                      onPress={() => setLeftOut((l) => (l.includes(b.id) ? l.filter((x) => x !== b.id) : [...l, b.id]))} />
            )) : null}
            {signedFor.length > 0 && visit.billable.length > 0 ? (
              <Text style={type.soft}>Parts recorded for an option they signed for are usually covered by its price. Leave them for the office.</Text>
            ) : null}
            {problem ? <Notice tone="red">{problem}</Notice> : null}
            <Button label="Show the customer" disabled={source === null} onPress={() => {
              if (source === "work" && work.length === 0) { setProblem("Nothing is left to bill."); return; }
              setProblem(null);
              setStage("show");
            }} />
          </View>
        ) : null}

        {stage === "show" ? (
          <View>
            <Card>
              {(chosenEstimate ? chosenEstimate.invoice!.lines.map((l) => ({
                id: l.id, name: l.name, quantity: l.quantity, amount: l.unitPrice, saved: l.memberDiscountAmount,
              })) : priced.lines.map((l) => ({
                id: l.id, name: l.name, quantity: l.quantity, amount: l.unitPrice, saved: l.memberDiscount,
              }))).map((l) => (
                <View key={l.id} style={styles.line}>
                  <Text style={[type.body, { flex: 1 }]}>{Number(l.quantity) === 1 ? "" : `${Number(l.quantity)} x `}{l.name}</Text>
                  <Text style={type.body}>{formatAmount(l.amount)}</Text>
                  {/[1-9]/.test(l.saved) ? <Text style={styles.saved}>Member saves {formatAmount(l.saved)}</Text> : null}
                </View>
              ))}
              <View style={styles.totalRow}>
                <Text style={type.heading}>Total</Text>
                <Text style={styles.total}>{formatAmount(total)}</Text>
              </View>
            </Card>
            <SignatureBox initialName={visit.customer.name} confirmLabel="Accept and sign" onSigned={(d, n) => raise(d, n)} />
            <View style={{ marginTop: space.md, gap: space.sm }}>
              <Button label="The customer is not here: raise it unsigned" kind="secondary" onPress={() => void raise(null, null)} />
              <Button label="Back" kind="secondary" onPress={() => setStage("choose")} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3, gap: space.md },
  choice: { backgroundColor: color.canvas, borderRadius: 10, borderWidth: 2, borderColor: color.line, padding: space.lg },
  choiceOn: { borderColor: color.ink },
  line: { borderBottomWidth: 1, borderBottomColor: color.line, paddingVertical: space.sm, gap: space.xs },
  saved: { color: color.green, fontSize: 15 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: space.md },
  total: { fontSize: 24, fontWeight: "700", color: color.ink },
});
