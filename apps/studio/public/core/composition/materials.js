/** materials feature composition for one Studio instance. Instance-owned state and dependencies. */
import { createMaterialReaderController } from "../controllers/material-reader.js";
import { createMaterialPdfView } from "../views/material-pdf.js";
import { createMaterialListController } from "../controllers/material-list.js";
import { createMaterialReaderView } from "../views/material-reader.js";
import { createMaterialSelectionController } from "../controllers/material-selection.js";
import { createMaterialImportController } from "../controllers/material-import.js";
import { createMaterialBranchController } from "../controllers/material-branch.js";
import { createMaterialIntentStore } from "../controllers/material-intent-store.js";
import { createMaterialBranchView } from "../views/material-branch.js";
import { createMarkdownRenderer } from "../views/markdown.js";

export function createMaterialFeatures(deps) {

      const materialReaderController = createMaterialReaderController({
        get state() { return deps.environment.state; },
        get $() { return deps.$; },
        get document() { return deps.environment.document; },
        get renderMaterialReader() { return renderMaterialReader; },
        get showMaterialReader() { return showMaterialReader; },
        get api() { return deps.api; },
        get updatePdfPageRendering() { return updatePdfPageRendering; },
        get renderPdfPageTextIn() { return renderPdfPageTextIn; },
        get updateMatTail() { return updateMatTail; },
        get renderMaterialBlockElement() { return renderMaterialBlockElement; },
        get window() { return deps.environment.window; },
        get showError() { return deps.showError; },
        get materialReaderView() { return materialReaderView; },
        get materialSelectionController() { return materialSelectionController; },
        get hideMaterialReader() { return hideMaterialReader; },
        get renderMaterialsSection() { return renderMaterialsSection; },
        get restoreFocusRef() { return deps.restoreFocusRef; },
      });

      const materialPdfView = createMaterialPdfView({
        get document() { return deps.environment.document; },
        get state() { return deps.environment.state; },
        get window() { return deps.environment.window; },
        get materialReaderIsPdf() { return materialReaderIsPdf; },
      });

      const materialListController = createMaterialListController({
        get sessionUI() { return deps.sessionUI; },
        get setWorkspaceView() { return deps.setWorkspaceView; },
        get $() { return deps.$; },
        get state() { return deps.environment.state; },
        get mutedListItem() { return deps.mutedListItem; },
        get document() { return deps.environment.document; },
        get closeSidebar() { return deps.closeSidebar; },
        get openMaterial() { return openMaterial; },
        get api() { return deps.api; },
      });

      const materialReaderView = createMaterialReaderView({
        get state() { return deps.environment.state; },
        get $() { return deps.$; },
        get document() { return deps.environment.document; },
        get closeMaterialReader() { return closeMaterialReader; },
        get formatProductTime() { return deps.formatProductTime; },
        get switchMaterialVersion() { return switchMaterialVersion; },
        get renderMaterialBranchFlow() { return renderMaterialBranchFlow; },
        get updateMatSelectionBar() { return updateMatSelectionBar; },
        get openMaterial() { return openMaterial; },
        get materialReaderFocusReturn() { return materialReaderController.materialReaderFocusReturn; },
        get refreshMaterialDetail() { return refreshMaterialDetail; },
        get mutedLine() { return deps.mutedLine; },
        get window() { return deps.environment.window; },
        get flushPendingRerender() { return deps.flushPendingRerender; },
        get armMaterialSelection() { return armMaterialSelection; },
        get scheduleMaterialPositionSave() { return scheduleMaterialPositionSave; },
        get maybeLoadMoreMaterialBlocks() { return maybeLoadMoreMaterialBlocks; },
        get updatePdfPageRendering() { return updatePdfPageRendering; },
        get createPdfPageFrame() { return createPdfPageFrame; },
        get renderMarkdownInto() { return renderMarkdownInto; },
        get materialReaderIsPdf() { return materialReaderIsPdf; },
        get loadMoreMaterialBlocks() { return loadMoreMaterialBlocks; },
      });

      const materialSelectionController = createMaterialSelectionController({
        get window() { return deps.environment.window; },
        get materialReaderIsPdf() { return materialReaderIsPdf; },
        get state() { return deps.environment.state; },
        get disarmArmedSelection() { return deps.disarmArmedSelection; },
        get document() { return deps.environment.document; },
        get guard() { return deps.guard; },
        get startMaterialBranchFlow() { return startMaterialBranchFlow; },
        get navigator() { return deps.environment.navigator; },
        get showError() { return deps.showError; },
      });

      const materialImportController = createMaterialImportController({
        get $() { return deps.$; },
        get state() { return deps.environment.state; },
        get refreshMaterials() { return refreshMaterials; },
        get fetch() { return deps.environment.fetch; },
        get window() { return deps.environment.window; },
        get api() { return deps.api; },
        get document() { return deps.environment.document; },
        get closeSidebar() { return deps.closeSidebar; },
        get openMaterial() { return openMaterial; },
      });

      const materialBranchController = createMaterialBranchController({
        get state() { return deps.environment.state; },
        get materialSelectionIdentity() { return materialSelectionIdentity; },
        get readPendingMaterialIntent() { return readPendingMaterialIntent; },
        get crypto() { return deps.environment.crypto; },
        get renderMaterialReader() { return renderMaterialReader; },
        get document() { return deps.environment.document; },
        get api() { return deps.api; },
        get rememberMaterialBranchOrigin() { return rememberMaterialBranchOrigin; },
        get branchView() { return deps.branchView; },
        get persistPendingMaterialIntent() { return persistPendingMaterialIntent; },
        get showError() { return deps.showError; },
        get clearPendingMaterialIntent() { return clearPendingMaterialIntent; },
        get closeMaterialReader() { return closeMaterialReader; },
        get openBranchPanel() { return deps.openBranchPanel; },
        get $() { return deps.$; },
        get recallMaterialBranchOrigin() { return recallMaterialBranchOrigin; },
        get openMaterial() { return openMaterial; },
      });

      const materialIntentStore = createMaterialIntentStore({
        get window() { return deps.environment.window; },
      });

      const materialBranchView = createMaterialBranchView({
        get state() { return deps.environment.state; },
        get document() { return deps.environment.document; },
        get mutedLine() { return deps.mutedLine; },
        get guard() { return deps.guard; },
        get startMaterialBranchFlow() { return startMaterialBranchFlow; },
        get materialBranchResumeExisting() { return materialBranchResumeExisting; },
        get materialBranchStartNew() { return materialBranchStartNew; },
        get persistPendingMaterialIntent() { return persistPendingMaterialIntent; },
        get materialSelectionIdentity() { return materialSelectionIdentity; },
        get submitMaterialFirstQuestion() { return submitMaterialFirstQuestion; },
        get materialBranchContinueWithQuestion() { return materialBranchContinueWithQuestion; },
        get closeMaterialBranchFlow() { return closeMaterialBranchFlow; },
        get turnElements() { return deps.turnElements; },
        get returnInsertedAt() { return deps.returnInsertedAt; },
        get MOTION_EPOCH_MS() { return deps.MOTION_EPOCH_MS; },
        get branchLabel() { return deps.branchLabel; },
        get formatProductTime() { return deps.formatProductTime; },
        get openDrawer() { return deps.openDrawer; },
        get recallMaterialReturnCard() { return recallMaterialReturnCard; },
        get openMaterial() { return openMaterial; },
      });


    const {
      saveMaterialReadingPositionNow,
      materialReaderIsPdf,
      openMaterial,
      closeMaterialReader,
      switchMaterialVersion,
      refreshMaterialDetail,
      scheduleMaterialPositionSave,
      maybeLoadMoreMaterialBlocks,
      loadMoreMaterialBlocks,
    } = materialReaderController;


    const { updatePdfPageRendering, renderPdfPageTextIn, createPdfPageFrame } = materialPdfView;


    const { renderMaterialsSection, materialListButtons, refreshMaterials } = materialListController;


    const { renderMaterialReader, hideMaterialReader, showMaterialReader, updateMatTail, renderMaterialBlockElement } = materialReaderView;


    const { updateMatSelectionBar, armMaterialSelection, findLiveMaterialSelection, disarmMaterialSelection } = materialSelectionController;


    const { resetMaterialImport, registerMaterialImportUi } = materialImportController;

    /** R1: lossless Markdown presentation belongs to the reader view. */
    const { renderMarkdownInto } = createMarkdownRenderer(deps.environment.document);


    const {
      isMaterialBranchView,
      startMaterialBranchFlow,
      materialBranchResumeExisting,
      materialBranchStartNew,
      submitMaterialFirstQuestion,
      materialBranchContinueWithQuestion,
      closeMaterialBranchFlow,
      materialSourceJump,
    } = materialBranchController;


    const {
      recallMaterialBranchOrigin,
      rememberMaterialReturnCard,
      materialSelectionIdentity,
      readPendingMaterialIntent,
      rememberMaterialBranchOrigin,
      persistPendingMaterialIntent,
      clearPendingMaterialIntent,
      recallMaterialReturnCard,
    } = materialIntentStore;


    const { materialReturnCard, renderMaterialBranchFlow } = materialBranchView;

  return {
    materialListButtons,
    isMaterialBranchView,
    materialReturnCard,
    recallMaterialBranchOrigin,
    materialReaderView,
    materialSelectionController,
    renderMaterialReader,
    updateMatSelectionBar,
    renderMaterialsSection,
    rememberMaterialReturnCard,
    resetMaterialImport,
    materialReaderController,
    hideMaterialReader,
    saveMaterialReadingPositionNow,
    refreshMaterials,
    openMaterial,
    registerMaterialImportUi,
    materialSourceJump,
    closeMaterialBranchFlow,
    closeMaterialReader,
    findLiveMaterialSelection,
    armMaterialSelection,
    disarmMaterialSelection,
  };
}
