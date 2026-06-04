import os

backup_path = r"www/byRhinoView.html.bak"
target_path = r"www/byRhinoView.html"

# Read the original clean file with UTF-8 encoding
with open(backup_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Style injection
style_target = """    gtag('config', 'G-1C1PRYC371');
  </script>
</head>"""

style_replacement = """    gtag('config', 'G-1C1PRYC371');
  </script>

  <!-- Premium Features Grid Scoped Styles -->
  <style>
    .byrhino-features-section {
      /* Dynamic Color Tokens - Default Light Theme */
      --bg-gradient: linear-gradient(135deg, hsl(210, 30%, 96%) 0%, hsl(210, 20%, 90%) 100%);
      --card-bg: hsla(0, 0%, 100%, 0.85);
      --card-border: hsla(210, 20%, 85%, 0.5);
      --text-main: hsl(220, 15%, 15%);
      --text-sub: hsl(220, 10%, 40%);
      --primary: hsl(215, 95%, 50%);
      --primary-subtle: hsl(215, 90%, 94%);
      --accent: hsl(260, 85%, 60%);
      --accent-subtle: hsl(260, 90%, 95%);
      
      font-family: 'Noto Sans KR', 'Noto Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-sizing: border-box;
      width: 100%;
    }

    @media (prefers-color-scheme: dark) {
      .byrhino-features-section {
        /* Premium Dark Theme */
        --bg-gradient: linear-gradient(135deg, hsl(220, 25%, 8%) 0%, hsl(220, 25%, 14%) 100%);
        --card-bg: hsla(220, 25%, 12%, 0.7);
        --card-border: hsla(220, 20%, 22%, 0.6);
        --text-main: hsl(210, 15%, 88%);
        --text-sub: hsl(210, 10%, 62%);
        --primary: hsl(210, 100%, 65%);
        --primary-subtle: hsl(210, 30%, 15%);
        --accent: hsl(260, 90%, 70%);
        --accent-subtle: hsl(260, 35%, 16%);
      }
    }

    .byrhino-features-section * {
      box-sizing: border-box;
    }

    .byrhino-features-section .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 24px;
      margin-top: 30px;
      margin-bottom: 50px;
      width: 100%;
    }

    /* --- Feature Card Styling --- */
    .byrhino-features-section .feature-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 4px 20px -5px rgba(0, 0, 0, 0.04);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease;
      display: flex;
      flex-direction: column;
      gap: 16px;
      text-align: left;
    }

    .byrhino-features-section .feature-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 24px -8px rgba(0, 0, 0, 0.1);
      border-color: var(--primary);
    }

    .byrhino-features-section .feature-header {
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
      margin-bottom: 4px;
    }

    .byrhino-features-section .feature-icon-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      background: var(--primary-subtle);
      color: var(--primary);
      border-radius: 10px;
      flex-shrink: 0;
    }

    .byrhino-features-section .feature-icon-wrapper svg {
      width: 22px;
      height: 22px;
    }

    .byrhino-features-section .feature-title {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
      letter-spacing: -0.01em;
      color: var(--text-main);
      line-height: 1.3;
    }

    .byrhino-features-section .feature-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-grow: 1;
    }

    .byrhino-features-section .feature-bullet {
      font-size: 14px;
      margin: 0;
      color: var(--text-sub);
      position: relative;
      padding-left: 20px;
      line-height: 1.5;
    }

    .byrhino-features-section .feature-bullet::before {
      content: "•";
      position: absolute;
      left: 4px;
      color: var(--accent);
      font-weight: bold;
    }
  </style>
</head>"""

# Verify we can find the style target
if style_target not in content:
    raise ValueError("Style target not found in byRhinoView.html.bak!")

content = content.replace(style_target, style_replacement)

# 2. Accordion replacement
# Find the start of the accordion
accordion_start = '<div class="panel-group accordion-style1" id="accordion-one">'

# We know the accordion ends with panels, a few tabs, closing div, and then closing columns.
# We will match the entire accordion block from '<div class="panel-group accordion-style1" id="accordion-one">'
# to the next unique signature containing the end of PWA and the closing tag:
accordion_end_marker = """                    <li class="margin-10px-bottom">
                      <b>12 Multilingual Adaptations</b>: Real-time UI language mapping matching the 12 primary localized dialects of Rhino 3D.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
          
        </div>"""

if accordion_start not in content:
    raise ValueError("Accordion start marker not found!")

if accordion_end_marker not in content:
    raise ValueError("Accordion end marker not found!")

# Let's extract the exact substring and replace it
start_idx = content.find(accordion_start)
end_idx = content.find(accordion_end_marker) + len(accordion_end_marker)

accordion_block = content[start_idx:end_idx]

grid_replacement = """<div class="byrhino-features-section">
          <div class="feature-grid">

            <!-- 1. Supported Formats -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">지원 파일 포맷</h2>
                <h2 class="feature-title lang-en">Supported CAD Formats</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>.3dm (Rhino 3D):</strong> 라이노 버전 5, 6, 7, 8 파일의 레이어, 선, 재질, 개체 색상을 완벽 복원하여 읽습니다.</p>
                <p class="feature-bullet lang-en"><strong>.3dm (Rhino 3D):</strong> Loads Rhino 5, 6, 7, and 8 models with high fidelity curve rendering, textures, and layers.</p>

                <p class="feature-bullet lang-ko"><strong>.glb / .gltf:</strong> 표준 3D 전송 형식을 빠르게 불러오고 매끄러운 텍스처를 구현합니다.</p>
                <p class="feature-bullet lang-en"><strong>.glb / .gltf:</strong> Efficiently imports standard 3D web assets and environment mappings.</p>

                <p class="feature-bullet lang-ko"><strong>.stl & .3mf:</strong> 3D 프린팅을 위한 메시 파일을 정밀 지원합니다.</p>
                <p class="feature-bullet lang-en"><strong>.stl & .3mf:</strong> Complete support for rapid prototyping stereolithography mesh data.</p>

                <p class="feature-bullet lang-ko"><strong>.stp / .step / .igs:</strong> 드롭 및 모바일 내파일 앱 연결을 통한 STEP/IGES 포맷 불러오기.</p>
                <p class="feature-bullet lang-en"><strong>.stp / .step / .igs:</strong> Convenient sessions and native model import via drag-and-drop or platform file sharing.</p>
              </div>
            </div>

            <!-- 2. Display & Shading Modes -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                    <polyline points="2 17 12 22 22 17"></polyline>
                    <polyline points="2 12 12 17 22 12"></polyline>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">쉐이딩 및 뷰 모드</h2>
                <h2 class="feature-title lang-en">Premium Shading Modes</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>음영 (Shaded):</strong> 와이어프레임 경계와 서피스 음영이 결합된 고전적 CAD 뷰.</p>
                <p class="feature-bullet lang-en"><strong>Shaded:</strong> Clean solid representation paired with precise wireframe borders.</p>

                <p class="feature-bullet lang-ko"><strong>와이어프레임 (Wireframe):</strong> 모델의 뼈대 곡선 및 메시 아웃라인만 표기하여 내부 점검 용이.</p>
                <p class="feature-bullet lang-en"><strong>Wireframe:</strong> Renders structural lines and boundary edges, perfect for reviewing complex shapes.</p>

                <p class="feature-bullet lang-ko"><strong>아키텍처 (Arctic):</strong> 부드러운 앰비언트 오클루전(AO) 그림자를 생성하여 형태의 입체감과 깊이를 고급스럽게 연출.</p>
                <p class="feature-bullet lang-en"><strong>Arctic (Ambient Occlusion):</strong> Premium architectural rendering utilizing soft ambient occlusion shadows, highlighting geometry shapes beautifully.</p>

                <p class="feature-bullet lang-ko"><strong>렌더링 (Rendered):</strong> 재질, 반사광, 실시간 태양 광선과 반사 환경을 완전 표현.</p>
                <p class="feature-bullet lang-en"><strong>Rendered:</strong> Realistic material representation with ground shadows and HDR environment reflections.</p>

                <p class="feature-bullet lang-ko"><strong>스케치 (Technical Sketch):</strong> 주요 테두리와 실루엣 아웃라인을 부각하는 예술적 도면 느낌 표출.</p>
                <p class="feature-bullet lang-en"><strong>Technical Sketch:</strong> Hand-drawn layout look highlighting main contours and silhouette drafts.</p>
              </div>
            </div>

            <!-- 3. Measurement & Analysis -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="2" y1="12" x2="22" y2="12"></line>
                    <line x1="2" y1="7" x2="2" y2="17"></line>
                    <line x1="22" y1="7" x2="22" y2="17"></line>
                    <line x1="12" y1="10" x2="12" y2="14"></line>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">정밀 분석 및 계측 도구</h2>
                <h2 class="feature-title lang-en">Measurement & Analysis</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>점 스냅 거리 측정:</strong> 서피스의 정점(Vertex)을 자동 스냅(Snap to Vertex)하여 두 점 간의 정확한 실제 직선 거리를 측정합니다.</p>
                <p class="feature-bullet lang-en"><strong>Snap to Vertex Distance:</strong> Automatically snap to vertices on loaded geometry meshes, ensuring extremely accurate real-world distance metrics.</p>

                <p class="feature-bullet lang-ko"><strong>각도 측정:</strong> 뷰포트 위의 세 정점을 탭하여 두 벡터 사이의 사잇각을 실시간 측정하고 시각화합니다.</p>
                <p class="feature-bullet lang-en"><strong>Angle Tool:</strong> Easily measure the angle between three custom-picked vertex points in real-time.</p>

                <p class="feature-bullet lang-ko"><strong>측정 내역 저장:</strong> 진행한 거리/각도 데이터가 히스토리 표에 차례대로 기록되어 일괄 지우거나 한눈에 점검 가능합니다.</p>
                <p class="feature-bullet lang-en"><strong>History Table:</strong> Review, clear, or track all of your measurements inside a neat floating overlay window.</p>

                <p class="feature-bullet lang-ko"><strong>클리핑 단면 분석:</strong> X, Y, Z축 축별 클리핑 단면 평면을 미세조정 슬라이더로 통제하고 단면 방향 반전(Flip) 및 리셋을 지원합니다.</p>
                <p class="feature-bullet lang-en"><strong>Clipping Plane:</strong> Custom 3-axis sectioning planes with interactive sliders, clipping direction flips, and quick resets.</p>
              </div>
            </div>

            <!-- 4. Environment & Lighting -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="5"></circle>
                    <line x1="12" y1="1" x2="12" y2="3"></line>
                    <line x1="12" y1="21" x2="12" y2="23"></line>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                    <line x1="1" y1="12" x2="3" y2="12"></line>
                    <line x1="21" y1="12" x2="23" y2="12"></line>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">조명 및 배경 환경 설정</h2>
                <h2 class="feature-title lang-en">Environment & Lighting</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>다양한 커스텀 배경:</strong> 단색, 2색 그라디언트, 방사형 그라디언트(확산 범위 제어), 4색 그라디언트 및 HDR 배경을 지원하며 프리미엄 색상 피커를 탑재했습니다.</p>
                <p class="feature-bullet lang-en"><strong>Custom Backgrounds:</strong> Support for Solid, 2-Color, Radial (with spread factor), 4-Color gradient, or HDR background modes powered by custom color pickers.</p>

                <p class="feature-bullet lang-ko"><strong>조명 프리셋 & HDR 로드:</strong> 스튜디오, 뉴트럴, 노을, 야간 등 라이팅 프리셋 및 외장 <code>.hdr</code>/<code>.exr</code> 조명 환경을 직접 로드해 적용합니다.</p>
                <p class="feature-bullet lang-en"><strong>HDR & Presets:</strong> Predefined settings (Studio, Sunset, etc.) and direct custom loading of high-fidelity <code>.hdr</code> or <code>.exr</code> files.</p>

                <p class="feature-bullet lang-ko"><strong>실시간 태양광 통제:</strong> 태양 조명 스위치 및 태양광 세기, 자전 방위각(Azimuth), 고도(Elevation)를 슬라이더로 조작합니다.</p>
                <p class="feature-bullet lang-en"><strong>Directional Sun:</strong> Fine-tune directional light intensity, rotation azimuth angle, and altitude elevation angle.</p>

                <p class="feature-bullet lang-ko"><strong>정밀 컬러 그레이딩:</strong> 노출(Exposure), 대비(Contrast), 채도(Saturation), 색온도(Temperature)를 보정해 인쇄나 프레젠테이션용 톤을 보정합니다.</p>
                <p class="feature-bullet lang-en"><strong>Color Grading:</strong> Adjust rendering tone with Exposure, Contrast, Saturation, and Temperature color-correction sliders.</p>
              </div>
            </div>

            <!-- 5. Camera & Navigation -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                    <circle cx="12" cy="13" r="4"></circle>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">카메라 및 네비게이션</h2>
                <h2 class="feature-title lang-en">Camera & Navigation</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>원근 / 평행 투영:</strong> 카메라 렌즈 투영 방식을 원근(Perspective) 및 엔지니어링 평행(Parallel/Orthographic)으로 전환합니다.</p>
                <p class="feature-bullet lang-en"><strong>Projection:</strong> Instantly switch between dynamic Perspective depth and parallel Orthographic display mode.</p>

                <p class="feature-bullet lang-ko"><strong>마찰력 & FOV 제어:</strong> 회전 관성 마찰 강도(Damping) 및 Perspective 화각(10° - 100°)을 미세 조절합니다.</p>
                <p class="feature-bullet lang-en"><strong>Damping & Perspective Angle:</strong> Adjust friction momentum inertia and perspective field of view easily.</p>

                <p class="feature-bullet lang-ko"><strong>Named View (뷰 저장):</strong> 3DM에 심겨 있는 기존 카메라 앵글을 가져오거나 현재 카메라 앵글을 신규 저장하고 전환 애니메이션을 지원합니다.</p>
                <p class="feature-bullet lang-en"><strong>Rhino Named Views:</strong> Imports named camera positions from Rhino files and saves custom camera orientations on the fly with animations.</p>

                <p class="feature-bullet lang-ko"><strong>턴테이블 회전:</strong> 지속적으로 회전하며 제품 형상을 다각도로 관찰하는 턴테이블 자전 모드(속도 및 방향 제어 가능).</p>
                <p class="feature-bullet lang-en"><strong>Turntable Auto-Rotate:</strong> Let the model rotate smoothly at variable speeds to observe details from all angles.</p>
              </div>
            </div>

            <!-- 6. Selection & Layers -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6"></line>
                    <line x1="8" y1="12" x2="21" y2="12"></line>
                    <line x1="8" y1="18" x2="21" y2="18"></line>
                    <line x1="3" y1="6" x2="3.01" y2="6"></line>
                    <line x1="3" y1="12" x2="3.01" y2="12"></line>
                    <line x1="3" y1="18" x2="3.01" y2="18"></line>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">개체 선택 및 레이어 관리</h2>
                <h2 class="feature-title lang-en">Selection & Layers</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>다양한 선택 모드:</strong> 선택 안함(None), 단일 선택(Single), 다중 선택(Multi-Select)을 지정해 개체 속성과 트리 정보를 확인합니다.</p>
                <p class="feature-bullet lang-en"><strong>Selection Modes:</strong> Toggle None, Single, and Multi-Select interaction styles to inspect object node details.</p>

                <p class="feature-bullet lang-ko"><strong>이름으로 개체 찾기:</strong> 개체 검색 기능을 이용해 3D 객체 파트를 이름으로 필터링하고 더블클릭하여 강조 표시하거나 탐색합니다.</p>
                <p class="feature-bullet lang-en"><strong>Find Object:</strong> Search mesh nodes by name to instantly isolate, highlight, or focus the camera on them.</p>

                <p class="feature-bullet lang-ko"><strong>레이어 하이러키 & 레이어 색상:</strong> CAD에 포함된 레이어 트리를 그대로 로드하고 레이어별 고유 색상 마커 서클을 매칭해 가시성을 제어합니다.</p>
                <p class="feature-bullet lang-en"><strong>Layer Hierarchy:</strong> Import full layers from native files, with matching Rhino colors and toggle switches.</p>
              </div>
            </div>

            <!-- 7. Session & Exports -->
            <div class="feature-card">
              <div class="feature-header">
                <div class="feature-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                  </svg>
                </div>
                <h2 class="feature-title lang-ko">세션 패키지 및 스마트 저장</h2>
                <h2 class="feature-title lang-en">Session & Exports</h2>
              </div>
              <div class="feature-body">
                <p class="feature-bullet lang-ko"><strong>.rhinoview 세션 저장:</strong> 단순히 모델만 저장하는 것이 아니라 카메라 앵글, 조명값, 그라디언트 배경 설정, 레이어 투명성, 표기된 거리 측정 주석들을 단일 패키지 파일로 한 번에 저장하고 리로드합니다.</p>
                <p class="feature-bullet lang-en"><strong>.rhinoview Session:</strong> Packages model geometry alongside active camera angles, gradients, annotations, lighting, and layers into a single portable session file.</p>

                <p class="feature-bullet lang-ko"><strong>고화질 스크린샷 캡처:</strong> 우측 하단 캔버스 이미지 스크린샷 캡처 기능을 통해 원클릭으로 PNG 형식의 배경 투명 스냅샷을 내보냅니다.</p>
                <p class="feature-bullet lang-en"><strong>Capture Screen:</strong> Generates and downloads crystal-clear PNG snapshots from the interactive WebGL canvas in one click.</p>

                <p class="feature-bullet lang-ko"><strong>GLB 내보내기:</strong> 파싱된 CAD 모델 기하 구조를 범용 3D 메시 압축 형식인 GLB 모델로 손쉽게 가공해 내보냅니다.</p>
                <p class="feature-bullet lang-en"><strong>Export GLB:</strong> Process and export loaded CAD structures to standard compressed binary GLB formats.</p>

                <p class="feature-bullet lang-ko"><strong>12개국 언어 지원:</strong> 다국어 인터네셔널라이제이션(i18n) 시스템으로 라이노 3D 언어 스택과 완전히 매칭되어 표시됩니다.</p>
                <p class="feature-bullet lang-en"><strong>12 Languages:</strong> Full i18n support matching Rhino's official localization portfolio.</p>
              </div>
            </div>

          </div>
        </div>"""

content = content.replace(accordion_block, grid_replacement)

# Save the final file with UTF-8 encoding
with open(target_path, "w", encoding="utf-8") as f:
    f.write(content)

print("SUCCESS: byRhinoView.html patched perfectly!")
