// (modules) group layout
import { Stack } from "expo-router";
import { Colors } from "@/src/theme";

export default function ModulesGroupLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.background },
        animation: "slide_from_right",
      }}
    />
  );
}
