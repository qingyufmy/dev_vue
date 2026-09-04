export { default as AnalysisDetailPanel } from './components/AnalysisDetailPanel.vue'
export { default as AnalystView } from './views/AnalystView.vue'
export { analysisTime, analysisValidity, biasLabel, biasTextClass, opportunityLabel } from './model/analysis-presentation'
export const loadAnalysisFullScreenSheet = () => import('./components/AnalysisFullScreenSheet.vue')
