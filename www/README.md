# byRhinoView

A lightweight Rhino 3D & CAD Web Viewer designed for seamless model interaction directly in the web browser. 

웹 브라우저에서 직접 매끄럽고 빠른 3D Rhino 및 CAD 모델 뷰잉과 상호작용을 지원하는 경량 웹 뷰어 솔루션입니다.

---

## 🌟 Key Features

* **High-Fidelity CAD Formats:** Support for `.3dm` (Rhino 3D), `.glb`, `.stl`, `.3mf`, and `.stp` (via session loads) file drops.
* **Premium Shading Modes:** Interactive shaded, wireframe, technical sketch, rendered, and beautiful **Arctic (Ambient Occlusion style)** modes.
* **Smart Session Management:** Save your entire viewing session—including camera perspectives, custom colors, layer visibilities, measurements, and lights—into a single `.rhinoview` package.
* **Named Views:** Save custom camera viewpoints and animate transitions seamlessly.
* **Analysis Tools:** In-app distance/angle measurement utilities and real-time interactive clipping plane sections.
* **12-Language Support (i18n):** Automatically adapts to 12 languages matching Rhino 3D (en, ko, fr, de, es, it, ja, zh-CN, zh-TW, pt-BR, cs, pl).

## 주요기능

* **3DM 및 CAD 포맷 지원**: `.3dm` (Rhino 3D), `.glb`, `.stl`, `.3mf` 및 드롭된 `.stp` 파일 완벽 지원.

* **프리미엄 쉐이딩 모드:** 음영, 와이어프레임, 스케치(Technical), 렌더링 및 아키텍처(앰비언트 오클루전 스타일) 모드 제공

* **스마트 세션 저장:** 카메라 각도, 조명 세기, 측정값, 레이어 가시성, 커스텀 색상까지 단일 `.rhinoview` 파일 하나로 저장 및 읽기

* **뷰 저장:** 라이노 NamedView 지원 및 나만의 카메라 앵글을 저장하고 애니메이션 트랜지션으로 시점을 전환.

* **분석 도구:** 실시간 표면 점 스냅 기반 거리/각도 측정 및 인터랙티브 클리핑 평면 단면 분석.

* **12개국 언어 대응 (i18n):** Rhino 3D와 일치하는 12개국 언어 다국어 실시간 번역 지원.

---

## 🛠️ Technology Stack

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

웹 서비스로 배포할 시에는 `www` 폴더 내부의 정적 리소스 파일들만 업로드하면 즉시 작동합니다. 

---

## ⚖️ Open Source & Third-Party Licenses

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

## 📄 License

The custom viewer logic, CSS styling, and integration layer of **byRhinoView** are licensed under the **MIT License**.

Copyright © 2026 Plus Plastic. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files...

---

## 🔒 Privacy Policy (개인정보처리방침)

**byRhinoView** values user privacy and operates completely offline and locally.

The dedicated, bilingual privacy policies are available in separate files:
* **Web Page (HTML):** [privacy.html](privacy.html)
* **Markdown (MD):** [privacy.md](privacy.md)

These files can be deployed directly to your static hosting domain (e.g., `https://<your-domain>/privacy.html`) to fulfill Google Play Store metadata requirements.
