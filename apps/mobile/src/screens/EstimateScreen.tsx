import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { draftTotals, findInPriceBook, formatAmount } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import {
  MAX_OPTIONS, addBookLine, addOption, addTypedLine, builderProblem, builderTaxRate, newBuilder, recommend,
  recordEstimate, removeLine, removeOption, renameOption, setOptional, type Builder,
} from "../lib/sell";
import { Button, Card, Notice, Section } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * BUILDING GOOD, BETTER AND BEST
 *
 * From the price book on the phone, searched with no signal, each line at the
 * price the book holds and the member's discount shown as it will be charged.
 * Saved into the queue like everything else, then turned round to the
 * customer. Nothing here shows a cost: the next screen faces the customer
 * and the technician's own screen should not be a habit of reading one.
 */
export function EstimateScreen({ visitId, nav }: { visitId: string; nav: Navigate }) {
  const field = useField();
  const visit = field.view?.day.visits.find((v) => v.id === visitId);
  const book = field.view?.priceBook ?? [];
  const newId = () => Crypto.randomUUID();
  const [builder, setBuilder] = useState<Builder>(() => newBuilder(newId, visit?.summary ?? ""));
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [typedPrice, setTypedPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!visit) {
    return (
      <View style={styles.root}>
        <Header onBack={nav.back} title="Estimate" />
        <Text style={[type.soft, { padding: space.lg }]}>This visit is no longer on your day.</Text>
      </View>
    );
  }

  const taxRate = builderTaxRate(builder) ?? "0";
  const active = builder.options[builder.active]!;
  const matches = findInPriceBook(book, query);

  const added = (result: { ok: true; builder: Builder } | { ok: false; problem: string }) => {
    if (!result.ok) { setProblem(result.problem); return; }
    setProblem(null);
    setBuilder(result.builder);
    setQuery("");
    setQuantity("1");
    setTypedPrice("");
  };

  const save = async () => {
    const wrong = builderProblem(builder);
    if (wrong) { setProblem(wrong); return; }
    setSaving(true);
    const estimateId = newId();
    await field.perform((phone) => recordEstimate(phone, { visitId, estimateId, builder }));
    setSaving(false);
    nav.back();
    nav.push({ name: "present", visitId, estimateId });
  };

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="New estimate" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.title}>{visit.customer.name}</Text>
        {visit.member ? (
          <Notice tone="green">
            {`${visit.member.planName} member. Their discount is taken off as you build.`}
          </Notice>
        ) : null}

        <View style={styles.tabs}>
          {builder.options.map((option, i) => (
            <Pressable key={option.id} accessibilityRole="tab" accessibilityState={{ selected: i === builder.active }}
                       accessibilityLabel={`Option ${option.name}`}
                       onPress={() => setBuilder({ ...builder, active: i })}
                       style={[styles.tab, i === builder.active && styles.tabOn]}>
              <Text style={[styles.tabText, i === builder.active && { color: "#fff" }]}>{option.name || "Unnamed"}</Text>
              <Text style={[type.soft, i === builder.active && { color: "#fff" }]}>
                {formatAmount(draftTotals(option, visit.member, taxRate).totals.total)}
              </Text>
            </Pressable>
          ))}
          {builder.options.length < MAX_OPTIONS ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Add another option" onPress={() => setBuilder(addOption(builder, newId))} style={styles.tab}>
              <Text style={styles.tabText}>+ Option</Text>
            </Pressable>
          ) : null}
        </View>

        <Section title="This option">
          <TextInput value={active.name} onChangeText={(name) => setBuilder(renameOption(builder, builder.active, name))}
                     style={styles.input} accessibilityLabel="Option name" placeholder="Name, like Repair" placeholderTextColor={color.inkFaint} />
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Button label={active.isRecommended ? "Recommended" : "Recommend this one"} kind="secondary"
                      onPress={() => setBuilder(recommend(builder, builder.active))} />
            </View>
            {builder.options.length > 1 ? (
              <View style={{ flex: 1 }}>
                <Button label="Remove option" kind="danger" onPress={() => setBuilder(removeOption(builder, builder.active))} />
              </View>
            ) : null}
          </View>

          {active.lines.length === 0 ? <Text style={[type.soft, { marginTop: space.md }]}>Nothing on it yet. Find something below.</Text> : null}
          {active.lines.map((line) => {
            const priced = draftTotals({ ...active, lines: [line] }, visit.member, taxRate).lines[0]!;
            return (
              <Card key={line.id}>
                <Text style={type.heading}>{Number(line.quantity)} x {line.name}</Text>
                {line.description ? <Text style={type.soft}>{line.description}</Text> : null}
                <Text style={type.body}>
                  {formatAmount(priced.gross)}
                  {/[1-9]/.test(priced.memberDiscount) ? `, member saves ${formatAmount(priced.memberDiscount)}` : ""}
                </Text>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Button label={line.isOptional ? "Optional extra" : "Make it optional"} kind="secondary"
                            onPress={() => setBuilder(setOptional(builder, line.id, !line.isOptional))} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button label="Remove" kind="danger" onPress={() => setBuilder(removeLine(builder, line.id))} />
                  </View>
                </View>
              </Card>
            );
          })}
        </Section>

        <Section title="Add from the price book">
          <View style={styles.row}>
            <TextInput value={query} onChangeText={setQuery} placeholder="Find an item or a kit" placeholderTextColor={color.inkFaint}
                       style={[styles.input, { flex: 3 }]} accessibilityLabel="Find in the price book" />
            <TextInput value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad"
                       style={[styles.input, { flex: 1 }]} accessibilityLabel="How many" />
          </View>
          {matches.map((entry) => (
            <Pressable key={entry.versionId} accessibilityRole="button" accessibilityLabel={`Add ${entry.name}`}
                       onPress={() => added(addBookLine(builder, entry, quantity, newId))} style={styles.match}>
              <View style={{ flex: 1 }}>
                <Text style={type.body}>{entry.code ? `${entry.code}  ` : ""}{entry.name}</Text>
                {(entry.components ?? []).length > 0
                  ? <Text style={type.soft}>Kit: {(entry.components ?? []).map((c) => c.name).join(", ")}</Text> : null}
              </View>
              <Text style={type.soft}>{formatAmount(entry.unitPrice)}</Text>
            </Pressable>
          ))}
          {query.trim() !== "" ? (
            <View style={[styles.row, { marginTop: space.sm }]}>
              <TextInput value={typedPrice} onChangeText={setTypedPrice} keyboardType="decimal-pad" placeholder="Price"
                         placeholderTextColor={color.inkFaint} style={[styles.input, { flex: 1 }]} accessibilityLabel="Price" />
              <View style={{ flex: 2 }}>
                <Button label={`Add "${query.trim()}"`} kind="secondary"
                        onPress={() => added(addTypedLine(builder, query, typedPrice, quantity, newId))} />
              </View>
            </View>
          ) : null}
        </Section>

        <Section title="Sales tax">
          <TextInput value={builder.taxPercent} onChangeText={(taxPercent) => setBuilder({ ...builder, taxPercent })}
                     keyboardType="decimal-pad" placeholder="Percent, or leave empty" placeholderTextColor={color.inkFaint}
                     style={styles.input} accessibilityLabel="Sales tax percent" />
        </Section>

        {problem ? <Notice tone="red">{problem}</Notice> : null}
        <Button label="Save and show the customer" busy={saving} onPress={() => void save()} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginVertical: space.lg },
  tab: {
    minWidth: 96, minHeight: 56, paddingHorizontal: space.md, borderRadius: 8, borderWidth: 1, borderColor: color.line,
    alignItems: "center", justifyContent: "center", backgroundColor: color.canvas,
  },
  tabOn: { backgroundColor: color.ink, borderColor: color.ink },
  tabText: { fontSize: 16, fontWeight: "600", color: color.ink },
  row: { flexDirection: "row", gap: space.sm, alignItems: "center", marginTop: space.sm },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: 8, paddingHorizontal: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.xs,
  },
  match: {
    flexDirection: "row", justifyContent: "space-between", minHeight: 52, alignItems: "center", gap: space.sm,
    borderBottomWidth: 1, borderBottomColor: color.line,
  },
});
