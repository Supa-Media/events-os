import { DoorAccessScreen } from "../../../../components/door/DoorAccessScreen";

/** Thin route wrapper — the screen (form, list, revoke) lives in
 *  `components/door/DoorAccessScreen.tsx` per the route-file-no-logic rule. */
export default function DoorAccessRoute() {
  return <DoorAccessScreen />;
}
