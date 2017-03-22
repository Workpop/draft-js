/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule editOnPaste
 * @flow
 */

'use strict';

var BlockMapBuilder = require('BlockMapBuilder');
var CharacterMetadata = require('CharacterMetadata');
var DataTransfer = require('DataTransfer');
var DraftModifier = require('DraftModifier');
var DraftPasteProcessor = require('DraftPasteProcessor');
var EditorState = require('EditorState');

var getEntityKeyForSelection = require('getEntityKeyForSelection');
var getTextContentFromFiles = require('getTextContentFromFiles');
var splitTextIntoTextBlocks = require('splitTextIntoTextBlocks');

import type {BlockMap} from 'BlockMap';
import type {EntityMap} from 'EntityMap';
import type DraftEditor from 'DraftEditor.react';

const isEventHandled = require('isEventHandled');

const ReactDOM = require('ReactDOM');
const UserAgent = require('UserAgent');

const doesNotSupportHTMLFromClipboard = UserAgent.isBrowser('IE') ||
  UserAgent.isBrowser('Edge') ||
  UserAgent.isBrowser('Safari');

/**
 * Paste content.
 */
function editOnPaste(editor: DraftEditor, e: SyntheticClipboardEvent): void {
  // e in this case is a native DOM event, instead of a SyntheticClipboardEvent,
  // when the event is at #document
  // For the pasteTrap to work, either we need to be capturing, or e.currentTarget needs to be
  // the contentEditable div. So, e in this case comes from a direct editor.addEventListener
  // Therefore, we need to replicate anything that the SyntheticClipboardEvent does that is used
  // Currently, that is only getting the clipboard, which involves falling back to window for IE & Edge.
  const clipboard = 'clipboardData' in event ? e.clipboardData : window.clipboardData;
  var data = new DataTransfer(clipboard);

  // Get files, unless this is likely to be a string the user wants inline.
  if (!data.isRichText()) {
    var files = data.getFiles();
    var defaultFileText = data.getText();
    if (files.length > 0) {
      // Allow customized paste handling for images, etc. Otherwise, fall
      // through to insert text contents into the editor.
      if (editor.props.handlePastedFiles && isEventHandled(editor.props.handlePastedFiles(files))) {
        return;
      }

      getTextContentFromFiles(files, (/*string*/ fileText) => {
        fileText = fileText || defaultFileText;
        if (!fileText) {
          return;
        }

        var editorState = editor._latestEditorState;
        var blocks = splitTextIntoTextBlocks(fileText);
        var character = CharacterMetadata.create({
          style: editorState.getCurrentInlineStyle(),
          entity: getEntityKeyForSelection(editorState.getCurrentContent(), editorState.getSelection()),
        });

        var text = DraftPasteProcessor.processText(blocks, character);
        var fragment = BlockMapBuilder.createFromArray(text);

        var withInsertedText = DraftModifier.replaceWithFragment(
          editorState.getCurrentContent(),
          editorState.getSelection(),
          fragment,
        );

        editor.update(EditorState.push(editorState, withInsertedText, 'insert-fragment'));
      });

      return;
    }
  }

  function handlePastedText(data: DataTransfer, pasteText: ?string, html: ?string): void {
    if (editor.props.handlePastedText && isEventHandled(editor.props.handlePastedText(pasteText, html))) {
      return;
    }

    let textBlocks: Array<string> = [];
    if (pasteText) {
      textBlocks = splitTextIntoTextBlocks(pasteText);
    }

    if (!editor.props.stripPastedStyles) {
      // If the text from the paste event is rich content that matches what we
      // already have on the internal clipboard, assume that we should just use
      // the clipboard fragment for the paste. This will allow us to preserve
      // styling and entities, if any are present. Note that newlines are
      // stripped during comparison -- this is because copy/paste within the
      // editor in Firefox and IE will not include empty lines. The resulting
      // paste will preserve the newlines correctly.
      const internalClipboard = editor.getClipboard();
      if ((text && html) && internalClipboard) {
        if (
          // If the editorKey is present in the pasted HTML, it should be safe to
          // assume this is an internal paste.
          html.indexOf(editor.getEditorKey()) !== -1 ||
          // The copy may have been made within a single block, in which case the
          // editor key won't be part of the paste. In this case, just check
          // whether the pasted text matches the internal clipboard.
          (textBlocks.length === 1 && internalClipboard.size === 1 && internalClipboard.first().getText() === pasteText)
        ) {
          editor.update(insertFragment(editor.props.editorState, internalClipboard));
          return;
        }
      }
      // If there is html paste data, try to parse that.
      if (html) {
        var htmlFragment = DraftPasteProcessor.processHTML(html, editor.props.blockRenderMap);
        if (htmlFragment) {
          var htmlMap = BlockMapBuilder.createFromArray(htmlFragment.contentBlocks);
          editor.update(insertFragment(editor.props.editorState, htmlMap));
          return;
        }
      }

      // Otherwise, create a new fragment from our pasted text. Also
      // empty the internal clipboard, since it's no longer valid.
      editor.setClipboard(null);
    }

    if (textBlocks.length) {
      var character = CharacterMetadata.create({
        style: editor.props.editorState.getCurrentInlineStyle(),
        entity: getEntityKeyForSelection(
          editor.props.editorState.getCurrentContent(),
          editor.props.editorState.getSelection(),
        ),
      });

      var textFragment = DraftPasteProcessor.processText(textBlocks, character);

      var textMap = BlockMapBuilder.createFromArray(textFragment);

      editor.update(insertFragment(editor.props.editorState, textMap));
    }
  }

  const text = data.getText();
  let html = getHTML(data);

  if (text && !html) {
    // The pasted content has text, but not HTML. For certain browsers (old versions of Safari, IE, and Edge)
    // the html isn't provided as part of the clipboardData. To work around this, follow the following algorithm:
    // Do NOT call e.preventDefault(). Instead, we want the browser to paste, just not in the editor element.
    // Instead, move focus to a dummy contentEditable div (the pasteTrap),
    // let the paste event through, and then copy the html out of the paste trap.
    // It is important to call setMode('paste') to disable the editor's event handlers (so it is blisfully unaware)
    // and then to properly undo the sleight-of-hand created.
    editor.setMode('paste');
    const pasteTrap = editor._pasteTrap;
    pasteTrap.focus();
    setTimeout(
      () => {
        html = pasteTrap.innerHTML;
        editor.focus();
        pasteTrap.innerHTML = '';
        editor.exitCurrentMode();
        handlePastedText(editor, text, html);
      },
      0,
    );
  } else {
    e.preventDefault();
    handlePastedText(editor, text, html);
  }
}

function getHTML(data: DataTransfer) {
  // Work around DataTransfer issue in IE11 https://github.com/facebook/draft-js/issues/656
  if (data.data.getData && !data.types.length) {
    return undefined;
  }
  return data.getHTML();
}

function insertFragment(editorState: EditorState, fragment: BlockMap, entityMap: ?EntityMap): EditorState {
  var newContent = DraftModifier.replaceWithFragment(
    editorState.getCurrentContent(),
    editorState.getSelection(),
    fragment,
  );
  return EditorState.push(editorState, newContent.set('entityMap', entityMap), 'insert-fragment');
}

function areTextBlocksAndClipboardEqual(textBlocks: Array<string>, blockMap: BlockMap): boolean {
  return textBlocks.length === blockMap.size &&
    blockMap.valueSeq().every((block, ii) => block.getText() === textBlocks[ii]);
}

module.exports = editOnPaste;
