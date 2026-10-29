# 개발·테스트 안내

Node.js 22.13 이상과 npm, Git이 필요합니다. React·TypeScript 화면, Cloudflare Worker API, D1 데이터베이스, 비공개 R2 파일 저장소로 구성되어 있습니다.

**처음 실행하기**

```sh
git clone https://github.com/hijaek/undongbang.git
cd undongbang
npm ci
npm run qa
```

`http://127.0.0.1:4190/__qa`를 여세요. 방장·회원·신규 사용자 테스트 계정을 선택할 수 있습니다. 실제 앱 화면과 API가 로컬 D1/R2에 연결됩니다. 서버를 다시 켜면 테스트 데이터가 새로 만들어집니다. 종료는 Ctrl+C입니다.

이 환경은 Google 로그인 없이 기능을 개발하기 위한 **로컬 전용 검증 서버**입니다. 운영 데이터나 운영 인증 정보에 연결되지 않습니다. 외부로 공개하지 마세요. React 코드를 바꾸면 서버를 다시 실행하세요. 운영 빌드에는 이 테스트 로그인 경로가 포함되지 않습니다.

**검사하기**

```sh
npm test
npm run typecheck
npm run build
```

테스트는 별도 D1/R2에서 인증·권한·인증 삭제·정산·백업·복구를 확인합니다. PR과 main 변경 시 GitHub Actions에서도 같은 검사를 실행합니다. 화면 폭 402px, 짧아진 화면, 긴 이름, 빈 기록, 실패 후 재시도를 함께 확인해주세요. 데스크톱 화면 크기 검사와 실제 iOS Chrome 검사는 구분해 기록해주세요.

**코드 찾기**

| 위치 | 하는 일 |
|---|---|
| `components/` | 피드, 인증, 댓글, 프로필, 방장 화면 |
| `app/design.css` | 모바일 디자인 |
| `server/api.ts` | 로그인한 사용자 요청 처리 |
| `server/accounting.ts` | 주 마감·벌금·분배 |
| `server/backups.ts` | 백업·복구 |
| `drizzle/` | 데이터베이스 구조 변경 이력 |
| `tests/` | 자동 검사와 로컬 검증 데이터 |

**실제 Google 연결과 배포**

직접 운영하려면 별도의 Google OAuth 프로젝트, D1, 비공개 R2, 서버 비밀 설정이 필요합니다. Google Sheets API를 활성화하고 본인 도메인의 `/auth/callback`을 OAuth 리디렉션 URI로 등록하세요. 로그인에는 기본 프로필 권한, 방장 시트 연결에는 별도 Sheets 권한을 요청합니다.

서버 설정: `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_SECRET`. APP_SECRET은 암호학적으로 생성한 32바이트 이상의 비밀값입니다. 예시 값을 운영에 쓰지 마세요. 자동 운영의 `OPS_OWNER_EMAIL`, `OPS_SERVICE_HASH`는 운영 안내를 참고하세요. 비밀값은 호스팅의 비밀 관리 기능으로 설정하고 저장소에는 넣지 않습니다.

`drizzle/*.sql`을 이름순으로 데이터베이스에 적용하세요. `DB`, `BUCKET` 바인딩을 준비하고 `.openai/hosting.json`에는 본인이 등록한 Sites 프로젝트만 연결하세요. 이 공개 사본에는 운동방 운영 프로젝트 ID, 시트 주소, 비밀 키, 회원 데이터가 없습니다. `npm run dev`는 별도 로컬 DB 초기화와 실제 OAuth 설정이 필요한 개발 서버이며, 빠른 화면 수정에는 위의 `npm run qa`를 권장합니다.

현재 운영 서비스는 Sites를 통해 별도로 배포합니다. GitHub PR을 병합해도 자동으로 운영 사이트에 배포되지 않습니다. 관리자가 변경 사항을 운영 소스에 반영하고 검사한 뒤 배포합니다. 적용한 DB 마이그레이션은 수정하지 말고 새 파일을 추가하세요.
