# byRhinoView

A premium, lightweight, and high-performance 3D Rhino & CAD Web Viewer designed for seamless model interaction directly in the web browser. 

웹 브라우저에서 직접 매끄럽고 빠른 3D Rhino 및 CAD 모델 뷰잉과 상호작용을 지원하는 고성능 경량 웹 뷰어 솔루션입니다.

---

## 🌟 Key Features (주요 기능)

### English (Base)
* **High-Fidelity CAD Formats:** Native support for `.3dm` (Rhino 3D), `.glb`, `.stl`, `.3mf`, and `.stp` (via session loads) file drops.
* **Premium Shading Modes:** Interactive shaded, wireframe, technical sketch, rendered, and beautiful **Arctic (Ambient Occlusion style)** modes.
* **Smart Session Management:** Save your entire viewing session—including camera perspectives, custom colors, layer visibilities, measurements, and lights—into a single `.rhinoview` package.
* **Dynamic Named Views:** Save custom camera viewpoints and animate transitions seamlessly.
* **Precision Analysis Tools:** In-app distance/angle measurement utilities and real-time interactive clipping plane sections.
* **12-Language Support (i18n):** Automatically adapts to 12 languages matching Rhino 3D (en, ko, fr, de, es, it, ja, zh-CN, zh-TW, pt-BR, cs, pl).

### 한국어 (추가)
* **고성능 CAD 포맷 지원:** `.3dm` (Rhino 3D), `.glb`, `.stl`, `.3mf` 및 드롭된 `.stp` 파일 완벽 지원.
* **프리미엄 쉐이딩 모드:** 음영, 와이어프레임, 스케치(Technical), 렌더링 및 유려한 **아키텍처(Arctic, 앰비언트 오클루전 스타일)** 모드 제공.
* **스마트 세션 저장:** 카메라 각도, 조명 세기, 측정값, 레이어 가시성, 커스텀 색상까지 단일 `.rhinoview` 파일 하나로 통째로 저장 및 복원.
* **동적 뷰어 앵글(Named Views):** 나만의 카메라 앵글을 저장하고 애니메이션 트랜지션으로 시점을 전환.
* **정밀 분석 도구:** 실시간 표면 점 스냅 기반 거리/각도 측정 및 인터랙티브 클리핑 평면 단면 분석.
* **12개국 공식 언어 대응 (i18n):** Rhino 3D와 일치하는 12개국 언어 다국어 실시간 번역 지원.

---

## 🛠️ Technology Stack (기술 스택)

* **Core Structure:** Pure HTML5 semantic elements
* **Design & Styling:** Vanilla CSS3 (Custom HSL properties, Glassmorphism, animations, Responsive Design)
* **Logic:** Modular Javascript (ES6 modules)
* **3D Engine:** Three.js (WebGL 3D Engine)
* **CAD Parsing:** rhino3dm.js (WebAssembly CAD importer)
* **Raycasting:** three-mesh-bvh (Fast GPU-based spatial index)
* **Color System:** Coloris (Premium Vanilla color picker)

---

## 📂 Deployment & Clean Distribution (배포 및 폴더 정리)

To deploy **byRhinoView** on any static web host (GitHub Pages, Netlify, Vercel, AWS S3, etc.), you only need to copy the contents of the `www` folder. 

웹 서비스로 배포할 시에는 `www` 폴더 내부의 정적 리소스 파일들만 업로드하면 즉시 작동합니다. 배포를 진행하기 전에 불필요한 테스트 및 임시 파일을 삭제하여 패키지 용량을 최적화하고 보안을 강화하는 것이 좋습니다.

### 🧹 Unnecessary Files Removed (삭제된 불필요 파일 목록)
* `app.js.bak`: 임시 백업 코드 파일
* `coloris-test.html`: Coloris 컬러 피커 독립 실행 테스트 파일
* `diagnostic.html`: 초기 Three.js 및 Rhino3dm 구동 테스트용 진단 파일

---

## ⚖️ Open Source & Third-Party Licenses (오픈소스 라이선스 정보)

**byRhinoView** is built upon and inspired by the following incredible open-source projects. All libraries are distributed under their respective permissive licenses:

### 1. Three.js
* **License:** MIT License
* **Copyright:** Copyright © 2010-2026 three.js authors
* **Purpose:** Core WebGL 3D rendering pipeline and scenegraph.

### 2. rhino3dm.js (Robert McNeel & Associates)
* **License:** MIT License
* **Copyright:** Copyright © 2026 Robert McNeel & Associates
* **Purpose:** WebAssembly-based parser for native Rhino `.3dm` files.

### 3. three-mesh-bvh
* **License:** MIT License
* **Copyright:** Copyright © 2026 Garrett Johnson
* **Purpose:** High-performance BVH spatial index for interactive object picking and measurements.

### 4. Coloris
* **License:** MIT License
* **Copyright:** Copyright © 2026 Mohammed S. A.
* **Purpose:** Vanilla CSS/JS beautiful custom color picker.

---

## 📄 License (라이선스)

The custom viewer logic, CSS styling, and integration layer of **byRhinoView** are licensed under the **MIT License**.

Copyright © 2026 byRhinoView Authors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files...
