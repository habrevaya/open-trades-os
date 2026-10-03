import { StyleSheet } from "react-native";

/**
 * The same rules as the web page's day: built for a phone held in one hand,
 * often gloved, often in sunlight. Controls at least 48 points tall, text no
 * smaller than 15, and every colour that carries meaning also carried by a
 * word, because the screen is frequently unreadable and the technician is
 * working from memory of where the button is.
 */
export const color = {
  ink: "#16181d",
  inkSoft: "#4a505c",
  inkFaint: "#6b7280",
  canvas: "#ffffff",
  page: "#f4f5f7",
  line: "#d5d8de",
  amber: "#8a4b00",
  amberTint: "#fff3e0",
  red: "#b42318",
  redTint: "#fdecea",
  green: "#1d6b3a",
  greenTint: "#e7f5ec",
  blue: "#1f4fd1",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const type = StyleSheet.create({
  title: { fontSize: 22, fontWeight: "600", color: color.ink },
  heading: { fontSize: 17, fontWeight: "600", color: color.ink },
  body: { fontSize: 16, color: color.ink, lineHeight: 22 },
  soft: { fontSize: 15, color: color.inkSoft, lineHeight: 21 },
  label: { fontSize: 13, color: color.inkFaint, textTransform: "uppercase", letterSpacing: 0.6 },
});
