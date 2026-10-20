import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });

monaco.editor.defineTheme('cc-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#12151c',
    'editorGutter.background': '#12151c',
    'editor.selectionBackground': '#7c6cf655',
    'editor.lineHighlightBackground': '#181c26',
    'editorCursor.foreground': '#7c6cf6',
  },
});
monaco.editor.defineTheme('cc-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editor.selectionBackground': '#7c6cf633',
    'editor.lineHighlightBackground': '#f0f2f8',
    'editorCursor.foreground': '#6558d8',
  },
});