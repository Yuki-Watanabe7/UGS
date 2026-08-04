/**
 * Issue #216: 接触ネットワークUIの表示文言。
 * 「人気」「中心人物」など価値判断的表現は使わない。
 */
import type { ContactNetworkWeightMode } from "./contactNetworkProjection";

export const WEIGHT_MODE_LABEL: Record<ContactNetworkWeightMode, string> = {
  totalCoPresenceTicks: "同席tick合計",
  contactIntervalCount: "接触区間数",
  distinctClusterCount: "異なるcluster数",
  binary: "接触の有無",
};

export const WEIGHT_MODE_UNIT: Record<ContactNetworkWeightMode, string> = {
  totalCoPresenceTicks: "tick",
  contactIntervalCount: "回",
  distinctClusterCount: "cluster",
  binary: "(有=1)",
};

export const WEIGHT_MODE_DESCRIPTION: Record<ContactNetworkWeightMode, string> = {
  totalCoPresenceTicks: "全contact intervalの区間長合計",
  contactIntervalCount: "同席した区間の件数",
  distinctClusterCount: "同席した異なるclusterの数",
  binary: "1つ以上の接触があれば1、なければ辺なし",
};
