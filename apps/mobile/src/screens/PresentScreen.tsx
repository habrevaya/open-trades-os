import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  decidable, formatAmount, optionTotal, presentationOrder, type FieldEstimateOption,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { recordApproval, recordDecline } from "../lib/sell";
import { SignatureBox } from "../components/SignatureBox";
import { Button, Card, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * THE CUSTOMER'S SCREEN
 *
 * The phone turned round. The options side by side in the order a proposal
 * uses (recommended first, then the dearest), each line at its price with the
 * member's saving said, the optional extras to tick, and the total for what
 * is ticked. Built only from what the customer may see: there is no cost or
 * margin on the phone to leave out.
 *
 * Their choice and their signature go into the queue as theirs: the drawn
 * signature first, then the approval naming it and the figure they were
 * shown, which the server checks before it records a yes.
 */
export function PresentScreen({ visitId, estimateId, nav }: { visitId: string; estimateId: string; nav: Navigate }) {
  const field = useField();
  const visit = field.view?.day.visits.find((v) => v.id === visitId);
  const estimate = visit?.estimates.find((e) => e.id === estimateId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [stage, setStage] = useState<"choose" | "sign" | "decline">("choose");
  const [reason, setReason] = useState("");

  if (!visit || !estimate) {
    return (
      <View style={styles.root}>
        <Header onBack={nav.back} title="Estimate" />
        <Text style={[type.soft, { padding: space.lg }]}>This estimate is not on your day any more.</Text>
      </View>
    );
  }

  const options = presentationOrder(estimate.options);
  const option = options.find((o) => o.id === chosen) ?? null;
  const open = decidable(estimate);

  const approve = async (dataUrl: string, signerName: string): Promise<string | null> => {
    if (!option) return "Choose an option first.";
    const kept = await field.keepDrawnSignature(dataUrl);
    if ("problem" in kept) return kept.problem;
    await field.perform((phone) => recordApproval(phone, {
      visitId, estimateId, option, ticked, signerName, signature: kept,
    }));
    nav.back();
    return null;
  };

  const decline = async () => {
    await field.perform((phone) => recordDecline(phone, { visitId, estimateId, reason }));
    nav.back();
  };

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title={estimate.number ? `Estimate ${estimate.number}` : "Your options"} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.title}>{estimate.title ?? "Your options"}</Text>
        <Text style={type.soft}>For {visit.customer.name}{visit.member ? `, ${visit.member.planName} member pricing` : ""}</Text>

        {!open ? (
          <Notice tone={estimate.status === "declined" ? "amber" : "green"}>
            {estimate.status === "declined" ? "They said no to this one."
              : `Chosen${estimate.signerName ? ` and signed by ${estimate.signerName}` : ""}.${estimate.waiting ? " Waiting to send." : ""}`}
          </Notice>
        ) : null}

        {stage === "choose" ? options.map((o) => (
          <OptionCard key={o.id} option={o} chosen={o.id === chosen} open={open} selectedOptionId={estimate.selectedOptionId}
                      ticked={ticked} onChoose={() => { setChosen(o.id); setTicked([]); }}
                      onTick={(lineId) => setTicked((t) => (t.includes(lineId) ? t.filter((x) => x !== lineId) : [...t, lineId]))} />
        )) : null}

        {estimate.terms && stage !== "decline" ? (
          <Card>
            <Text style={type.label}>Terms</Text>
            <Text style={[type.soft, { marginTop: space.xs }]}>{estimate.terms}</Text>
          </Card>
        ) : null}

        {open && stage === "choose" ? (
          <View style={{ gap: space.sm }}>
            <Button label={option ? `Choose ${option.name}: ${formatAmount(optionTotal(option, ticked))}` : "Tap an option to choose it"}
                    disabled={!option} onPress={() => setStage("sign")} />
            <Button label="Not today" kind="secondary" onPress={() => setStage("decline")} />
          </View>
        ) : null}

        {stage === "sign" && option ? (
          <View>
            <Card>
              <Text style={type.heading}>{option.name}</Text>
              <Text style={styles.total}>{formatAmount(optionTotal(option, ticked))}</Text>
              <Text style={type.soft}>Signing approves this option and its price.</Text>
            </Card>
            <SignatureBox initialName={visit.customer.name} confirmLabel="Approve and sign" onSigned={approve} />
            <View style={{ marginTop: space.md }}>
              <Button label="Back to the options" kind="secondary" onPress={() => setStage("choose")} />
            </View>
          </View>
        ) : null}

        {stage === "decline" ? (
          <View>
            <Text style={type.body}>What did they say? It helps the office follow up.</Text>
            <TextInput value={reason} onChangeText={setReason} placeholder="Getting another quote, too dear, not now"
                       placeholderTextColor={color.inkFaint} style={styles.input} multiline accessibilityLabel="Why not" />
            <View style={{ gap: space.sm }}>
              <Button label="Record that they said no" kind="danger" onPress={() => void decline()} />
              <Button label="Back to the options" kind="secondary" onPress={() => setStage("choose")} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function OptionCard({ option, chosen, open, selectedOptionId, ticked, onChoose, onTick }: {
  option: FieldEstimateOption; chosen: boolean; open: boolean; selectedOptionId: string | null;
  ticked: string[]; onChoose: () => void; onTick: (lineId: string) => void;
}) {
  const total = optionTotal(option, chosen ? ticked : option.lines.filter((l) => l.isOptional && l.isSelected).map((l) => l.id));
  const picked = chosen || (!open && selectedOptionId === option.id);
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: picked, disabled: !open }}
               accessibilityLabel={`${option.name}, ${formatAmount(total)}`}
               onPress={open ? onChoose : undefined}
               style={[styles.option, picked && styles.optionOn]}>
      <View style={styles.optionHead}>
        <Text style={type.heading}>{option.name}{option.isRecommended ? "  (recommended)" : ""}</Text>
        <Text style={styles.total}>{formatAmount(total)}</Text>
      </View>
      {option.description ? <Text style={type.soft}>{option.description}</Text> : null}
      {option.lines.map((line) => {
        const saved = /[1-9]/.test(line.memberDiscountAmount);
        const included = !line.isOptional || (chosen ? ticked.includes(line.id) : line.isSelected);
        return (
          <View key={line.id} style={styles.line}>
            <Text style={[type.body, { flex: 1 }]}>
              {Number(line.quantity) === 1 ? "" : `${Number(line.quantity)} x `}{line.name}
              {line.isOptional ? (included ? "  (added)" : "  (optional)") : ""}
            </Text>
            <Text style={type.body}>{formatAmount(line.unitPrice)}</Text>
            {saved ? <Text style={styles.saved}>Member saves {formatAmount(line.memberDiscountAmount)}</Text> : null}
            {line.isOptional && open && chosen ? (
              <Button label={included ? "Take it off" : "Add this"} kind="secondary" onPress={() => onTick(line.id)} />
            ) : null}
          </View>
        );
      })}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3, gap: space.md },
  option: {
    backgroundColor: color.canvas, borderRadius: 10, borderWidth: 2, borderColor: color.line, padding: space.lg,
  },
  optionOn: { borderColor: color.ink },
  optionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: space.xs },
  total: { fontSize: 24, fontWeight: "700", color: color.ink },
  line: { borderTopWidth: 1, borderTopColor: color.line, paddingVertical: space.sm, gap: space.xs },
  saved: { color: color.green, fontSize: 15 },
  input: {
    minHeight: 80, borderWidth: 1, borderColor: color.line, borderRadius: 8, padding: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.sm, textAlignVertical: "top",
  },
});
