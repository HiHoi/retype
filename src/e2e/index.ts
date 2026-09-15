// 확장 호스트 안에서 돈다. 채팅 패널 대신 우리가 MCP 클라이언트가 되어 붙고,
// 사람 대신 `type` 커맨드로 친다. Copilot 자체는 여기서 검사하지 않는다.
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type Api = { port: number; hasActive: () => boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('기다리다 지쳤다');
    await sleep(30);
  }
}

async function type(text: string) {
  await vscode.commands.executeCommand('type', { text });
}

async function openDoc(content = '') {
  const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
  return vscode.window.showTextDocument(doc, { preview: false });
}

function parse<T>(res: Awaited<ReturnType<Client['callTool']>>): T {
  const c = (res.content as { type: string; text: string }[])[0];
  return JSON.parse(c.text);
}

export async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'retype');
  assert.ok(ext, '익스텐션을 못 찾았다');
  const api: Api = await ext.activate();
  assert.ok(api.port > 0);

  const client = new Client({ name: 'retype-e2e', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${api.port}/mcp`))
  );

  // 따라쓰기·변경 제안·진단·뷰포트 툴이 보인다
  {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'propose',
      'propose_change',
      'read_diagnostics',
      'read_viewport',
    ]);
  }

  // propose_change: 선택된 기존 코드를 사람이 직접 새 코드로 교체하면 typed:true
  {
    const editor = await openDoc('const value = old;\nkeep();');
    const pending = client.callTool({
      name: 'propose_change',
      arguments: {
        startLine: 1,
        endLine: 1,
        oldText: 'const value = old;',
        text: 'const value = new;',
        why: '값의 기본값을 교체',
      },
    });
    await until(() => api.hasActive());
    await type('const value = new;');
    const r = parse<{ typed: boolean }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(editor.document.getText(), 'const value = new;\nkeep();');
  }

  // propose_change: 기존 코드를 먼저 지운 뒤 새 코드를 직접 입력해도 완료된다
  {
    const editor = await openDoc('const value = old;');
    const pending = client.callTool({
      name: 'propose_change',
      arguments: {
        startLine: 1,
        endLine: 1,
        oldText: 'const value = old;',
        text: 'const value = new;',
        why: '값을 직접 교체',
      },
    });
    await until(() => api.hasActive());
    await vscode.commands.executeCommand('deleteLeft');
    await type('const value = new;');
    const r = parse<{ typed: boolean }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(editor.document.getText(), 'const value = new;');
  }

  // propose_change: 현재 코드가 oldText와 다르면 stale로 즉시 종료한다
  {
    await openDoc('const value = current;');
    const r = parse<{ typed: boolean; reason: string }>(
      await client.callTool({
        name: 'propose_change',
        arguments: {
          startLine: 1,
          endLine: 1,
          oldText: 'const value = old;',
          text: 'const value = new;',
          why: 'stale 범위',
        },
      })
    );
    assert.deepEqual(r, { typed: false, reason: 'stale' });
    assert.equal(api.hasActive(), false);
  }

  // read_viewport: 보이는 파일과 본문을 돌려준다
  {
    const editor = await openDoc('one\ntwo\nthree');
    editor.selection = new vscode.Selection(1, 0, 1, 3);
    const v = parse<{ startLine: number; text: string; selection: string | null }>(
      await client.callTool({ name: 'read_viewport', arguments: {} })
    );
    assert.equal(v.startLine, 1);
    assert.equal(v.text, 'one\ntwo\nthree');
    assert.equal(v.selection, 'two');
  }

  // read_diagnostics: 현재 편집기의 diagnostics와 severity별 개수를 돌려준다
  {
    const editor = await openDoc('const broken = true;');
    const collection = vscode.languages.createDiagnosticCollection('retype-test');
    collection.set(editor.document.uri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 6, 0, 12),
        '검사용 오류',
        vscode.DiagnosticSeverity.Error
      ),
    ]);
    const r = parse<{
      diagnostics: {
        message: string;
        severity: string;
        source: string | null;
        code: string | number | null;
        startLine: number;
        startCharacter: number;
        endLine: number;
        endCharacter: number;
      }[];
      counts: { error: number };
    }>(await client.callTool({ name: 'read_diagnostics', arguments: {} }));
    assert.equal(r.counts.error, 1);
    assert.deepEqual(r.diagnostics[0], {
      message: '검사용 오류',
      severity: 'error',
      source: null,
      code: null,
      startLine: 1,
      startCharacter: 6,
      endLine: 1,
      endCharacter: 12,
    });
    collection.dispose();
  }

  // read_diagnostics: 지정한 파일이 없으면 조용히 빈 결과를 만들지 않고 오류로 알린다
  {
    const result = await client.callTool({
      name: 'read_diagnostics',
      arguments: { file: 'missing-retype-diagnostics.ts' },
    });
    assert.equal(result.isError, true);
  }

  // propose: 틀렸다 고치고 다 치면 typed:true, mistakes:1
  {
    const editor = await openDoc();
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'return raw', why: '검사용' },
    });
    await until(() => api.hasActive());

    await type('x'); // 오타
    await vscode.commands.executeCommand('deleteLeft');
    await type('return raw');

    const r = parse<{ typed: boolean; ms: number; mistakes: number }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(r.mistakes, 1);
    assert.ok(r.ms >= 0);
    assert.equal(editor.document.getText(), 'return raw');
    assert.equal(api.hasActive(), false);
  }

  // propose: line 지정 + 여러 줄. 자동 들여쓰기가 끼어도 끝난다
  {
    const editor = await openDoc('a\nb\n');
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'if x:\n    return 1', why: '줄 지정', line: 2 },
    });
    await until(() => api.hasActive());
    await type('if x:\n    return 1');
    const r = parse<{ typed: boolean; mistakes: number }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(r.mistakes, 0);
    assert.match(editor.document.getText(), /^a\nif x:\n\s+return 1b\n$/);
  }

  // 줄 끝에서 들여쓰기 있는 제안: Enter부터 치게 되고, 들여쓰기는 retype이 맞춘다 (dedent 포함)
  {
    const editor = await openDoc('if x:\n    pass');
    const endOfDoc = new vscode.Position(1, 8);
    editor.selection = new vscode.Selection(endOfDoc, endOfDoc);
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'return 1\nprint(2)', why: '줄 끝', line: undefined },
    });
    // 위 제안은 들여쓰기 없이 시작하지만 여러 줄이라 \n이 앞에 붙는다
    await until(() => api.hasActive());
    await type('\n'); // 자동 들여쓰기가 4칸 넣을 수 있다 → retype이 0칸으로 맞춘다
    await sleep(200);
    await type('return 1\n');
    await sleep(200);
    await type('print(2)');
    const r = parse<{ typed: boolean; mistakes: number }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(r.mistakes, 0);
    assert.equal(editor.document.getText(), 'if x:\n    pass\nreturn 1\nprint(2)');
  }

  // 들여쓰기를 틀리게(자동 들여쓰기 흉내) 넣어도 retype이 목표대로 고쳐놓는다
  {
    const editor = await openDoc();
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'a\n    b\nc', why: '들여쓰기 교정' },
    });
    await until(() => api.hasActive());
    await type('a\n');
    await type('        '); // 8칸 → 4칸으로
    await sleep(200);
    await type('b\n');
    await type('    '); // 4칸 → 0칸으로
    await sleep(200);
    await type('c');
    const r = parse<{ typed: boolean; mistakes: number }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(r.mistakes, 0);
    assert.equal(editor.document.getText(), 'a\n    b\nc');
  }

  // 따라쓰는 중에 윗줄을 지워도 앵커가 따라온다
  {
    const editor = await openDoc('junk\n');
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'return raw', why: '앵커', line: 2 },
    });
    await until(() => api.hasActive());
    await type('ret');
    await editor.edit((b) => b.delete(new vscode.Range(0, 0, 1, 0)));
    await type('urn raw');
    const r = parse<{ typed: boolean; mistakes: number }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(r.mistakes, 0);
    assert.equal(editor.document.getText(), 'return raw');
  }

  // 앵커 뒤에 기존 코드가 있어도, 커서를 그리로 옮겨도 그건 친 걸로 안 본다
  {
    const editor = await openDoc('existing tail');
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'return raw', why: '기존 코드', line: 1 },
    });
    await until(() => api.hasActive());
    await type('ret');
    editor.selection = new vscode.Selection(0, 16, 0, 16); // 기존 코드 끝으로 클릭
    await sleep(100);
    assert.equal(api.hasActive(), true);
    editor.selection = new vscode.Selection(0, 3, 0, 3); // 다시 회색 자리로
    await type('urn raw');
    const r = parse<{ typed: boolean; mistakes: number }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(r.mistakes, 0);
    assert.equal(editor.document.getText(), 'return rawexisting tail');
  }

  // Esc(retype.cancel) → cancelled
  {
    await openDoc();
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'never', why: '취소' },
    });
    await until(() => api.hasActive());
    await vscode.commands.executeCommand('retype.cancel');
    const r = parse<{ typed: boolean; reason: string }>(await pending);
    assert.deepEqual(r, { typed: false, reason: 'cancelled' });
  }

  // 다른 파일로 가버리면 → abandoned
  {
    await openDoc();
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'never', why: '이탈' },
    });
    await until(() => api.hasActive());
    await openDoc('elsewhere');
    const r = parse<{ typed: boolean; reason: string }>(await pending);
    assert.deepEqual(r, { typed: false, reason: 'abandoned' });
  }

  // 이미 있는 코드를 다시 제안하면 치게 하지 않고 already_present
  {
    await openDoc('import os\nimport sys\n');
    const r = parse<{ typed: boolean; reason: string }>(
      await client.callTool({
        name: 'propose',
        arguments: { text: 'import os\nimport sys', why: '중복', line: 1 },
      })
    );
    assert.deepEqual(r, { typed: false, reason: 'already_present' });
    assert.equal(api.hasActive(), false);
  }

  // 탭 파일이면 제안의 스페이스 들여쓰기가 탭으로 바뀐다
  {
    const editor = await openDoc('');
    editor.options = { insertSpaces: false, tabSize: 4 };
    const pending = client.callTool({
      name: 'propose',
      arguments: { text: 'a\n    b', why: '탭' },
    });
    await until(() => api.hasActive());
    await type('a\n\tb');
    const r = parse<{ typed: boolean }>(await pending);
    assert.equal(r.typed, true);
    assert.equal(editor.document.getText(), 'a\n\tb');
  }

  // 편집기가 없으면 propose는 에러
  {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const res = await client.callTool({
      name: 'propose',
      arguments: { text: 'x', why: 'no editor' },
    });
    assert.equal(res.isError, true);
  }

  await client.close();
  console.log('e2e: 모든 검사 통과');
}
