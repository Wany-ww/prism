/** 화면에 보이지 않는 파일 입력을 하나 만들어 JSON 파일을 고르게 하고, 파싱된 내용을 돌려준다 (Flow/대시보드 가져오기용). */
export function pickJsonFile(): Promise<any> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error('No file selected.'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch {
          reject(new Error('Not a valid JSON file.'));
        }
      };
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsText(file);
    };
    input.click();
  });
}
