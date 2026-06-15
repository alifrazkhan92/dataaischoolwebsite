#!/usr/bin/env python3
"""
DAIS Weekly Blog Generator
Generates a new SEO-optimised blog post each week using the Anthropic API,
creates a contextual hero image via Google Imagen 3, updates blog.html and
sitemap.xml, and saves the HTML file to blog/.

Required GitHub secrets:
  ANTHROPIC_API_KEY   -- Claude Sonnet (blog content)
  GEMINI_API_KEY      -- Google Imagen 3 (hero image); falls back to Pillow if absent
"""

import os
import sys
import json
import math
import textwrap
import datetime
import re
import ssl
import urllib.request
import urllib.parse

try:
    from google import genai as google_genai
    from google.genai import types as google_genai_types
    GOOGLE_GENAI_AVAILABLE = True
except ImportError:
    GOOGLE_GENAI_AVAILABLE = False
    print("WARNING: google-genai not installed. Imagen 3 unavailable; will use Pillow fallback.")

try:
    from PIL import Image, ImageDraw, ImageFont
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("WARNING: Pillow not installed. Fallback image generation unavailable.")


# ---------------------------------------------------------------------------
# Topic rotation. Each Monday picks the next unused topic.
# Tracks usage in blog/BLOG_TOPICS_USED.json (committed to repo).
# ---------------------------------------------------------------------------
TOPIC_QUEUE = [
    {
        "slug": "ofqual-ai-qualifications-uk-guide-2026",
        "title": "Ofqual-Regulated AI Qualifications in the UK: What They Are and Why They Matter",
        "tag": "Qualifications",
        "og_description": "Not all AI qualifications are equal. Learn what Ofqual regulation actually means, how it protects UK learners, and why employers and universities trust it.",
        "keywords": ["Ofqual AI qualification UK", "regulated AI course UK", "Ofqual RQF level 4", "AI diploma Ofqual", "UK AI qualification framework"],
        "angle": "Explain Ofqual's role in the UK qualifications ecosystem in plain language. Cover the RQF levels, what external quality assurance means for learners, how Ofqual-regulated qualifications differ from self-issued certificates, and why this matters when applying to UK jobs or universities. Reference NCFE and DAIS courses specifically.",
        "image_prompt": "A professional UK education setting, modern classroom with AI and technology theme, navy and gold color palette, students studying with laptops, official certificates and accreditation documents visible, London skyline in background"
    },
    {
        "slug": "ncfe-vs-pearson-btec-ai-data-uk",
        "title": "NCFE vs Pearson BTEC for AI and Data Careers: Which Should UK Learners Choose?",
        "tag": "Qualifications",
        "og_description": "Two of the UK's biggest awarding bodies both offer technology qualifications. Here is an honest, side-by-side comparison to help you choose the right one.",
        "keywords": ["NCFE vs Pearson BTEC", "BTEC data science UK", "NCFE data qualification", "Pearson BTEC AI UK", "best tech qualification UK 2026"],
        "angle": "Fair-minded comparison of NCFE and Pearson BTEC for technology and AI qualifications. Cover awarding body histories, Ofqual regulation status, employer recognition, university progression routes, assessment styles, and flexibility for working adults. Conclude with a recommendation framework based on learner goals.",
        "image_prompt": "Split comparison visual, two paths leading to UK tech career, professional business environment, technology and education symbols, navy blue and gold theme, modern London office buildings"
    },
    {
        "slug": "ai-careers-uk-higher-education-2026",
        "title": "AI Career Opportunities in UK Higher Education: 10 Roles That Are Hiring Now",
        "tag": "AI Careers",
        "og_description": "UK universities and colleges are actively hiring AI-skilled professionals. Here are the 10 most in-demand roles, what they pay, and how to qualify.",
        "keywords": ["AI jobs UK higher education", "AI career universities UK", "edtech jobs UK 2026", "AI in higher education UK", "university AI roles UK"],
        "angle": "Cover 10 specific AI-related roles being created in UK HE institutions: learning analytics lead, AI curriculum designer, AI ethics officer, data scientist, AI-augmented teaching specialist, etc. For each: responsibilities, salary range, and qualification requirements. Show how NCFE qualifications can be a route in.",
        "image_prompt": "Modern UK university campus with AI technology integration, diverse professionals working with computers and data visualisations, academic setting combined with tech innovation, navy and gold accents"
    },
    {
        "slug": "htq-higher-technical-qualifications-uk-ai",
        "title": "Higher Technical Qualifications (HTQs) Explained: The UK's Fast Track to AI and Tech Careers",
        "tag": "Qualifications",
        "og_description": "HTQs are endorsed by employers and approved by the Institute for Apprenticeships. Find out how they work and whether one is right for your AI career.",
        "keywords": ["Higher Technical Qualification UK", "HTQ AI UK", "HTQ data science", "IfATE qualification UK", "HTQ vs degree UK"],
        "angle": "Explain what HTQs are, the IfATE endorsement process, how they differ from standard diplomas, and the T-Level bridge they provide. Focus on HTQs in AI, data, and digital. Compare to degree apprenticeships and undergraduate routes. Explain NCFE's HTQ portfolio and how DAIS delivers them.",
        "image_prompt": "Confident UK professional completing higher education in technology, career progression visual with upward trajectory, modern clean office setting, official UK qualification documents, warm professional lighting"
    },
    {
        "slug": "ai-regulation-uk-eu-ai-act-career-impact",
        "title": "The EU AI Act and UK AI Regulation: What It Means for Your Career and Qualifications",
        "tag": "AI Policy",
        "og_description": "New AI regulation is reshaping which skills are valuable and which qualifications employers will demand. Here is what every UK professional needs to know.",
        "keywords": ["EU AI Act UK impact", "UK AI regulation 2026", "AI compliance career UK", "AI governance qualifications UK", "AI regulation jobs UK"],
        "angle": "Explain the EU AI Act's implications for UK-based businesses (even post-Brexit). Cover the UK's own AI regulatory approach, the AI Safety Institute, sector-specific rules, and what AI-adjacent compliance roles are emerging. Show how data and AI qualifications prepare professionals for this regulatory landscape.",
        "image_prompt": "AI governance and regulation theme, UK Houses of Parliament with digital AI overlay, professional regulatory environment, law books combined with technology, authoritative navy and gold colour scheme"
    },
    {
        "slug": "ncfe-level-4-htq-data-analyst-uk-review",
        "title": "NCFE Level 4 Data Analyst HTQ: Is It Worth It for UK Professionals in 2026?",
        "tag": "Course Review",
        "og_description": "An honest review of the NCFE Level 4 HTQ in Data Analyst: what you learn, what employers think, how long it takes, and whether it is right for your career.",
        "keywords": ["NCFE Level 4 data analyst", "HTQ data analyst UK", "NCFE data analyst review", "Level 4 data qualification UK", "NCFE HTQ worth it"],
        "angle": "In-depth review of the NCFE Level 4 HTQ Data Analyst qualification. Cover the unit breakdown, assessment methods (portfolio vs exam), time commitment, employer recognition, salary uplift data, and how it compares to doing a coding bootcamp or university module. Balanced and honest.",
        "image_prompt": "Data analyst at work in modern UK office, large screens showing data visualisations and dashboards, professional confident young adult, clean tech workspace, navy and gold corporate colour scheme"
    },
    {
        "slug": "generative-ai-uk-workplace-2026-guide",
        "title": "Generative AI in the UK Workplace: A Practical Guide for 2026",
        "tag": "AI Tools",
        "og_description": "From writing to coding to data analysis, generative AI is changing every UK workplace. This practical guide covers what to use, what to avoid, and how to upskill.",
        "keywords": ["generative AI UK workplace", "AI tools UK professionals", "ChatGPT at work UK", "Claude AI workplace UK", "AI productivity UK 2026"],
        "angle": "Practical guide for UK professionals who need to integrate AI into their daily work. Cover key tools by function (writing, coding, research, data), responsible use policies, what UK employers expect, IP and data concerns, and how having a formal qualification differentiates you from self-taught AI users.",
        "image_prompt": "Modern UK professional using AI tools on multiple screens, collaborative office environment, AI interface visualisations, productive professional atmosphere, tech-forward yet human-centred workplace"
    },
    {
        "slug": "uk-government-ai-opportunities-action-plan-careers",
        "title": "The UK Government AI Opportunities Action Plan: What It Means for Your Career",
        "tag": "AI Policy",
        "og_description": "The government has committed to making the UK an AI superpower. Here is what the Action Plan actually contains and how it creates real career opportunities.",
        "keywords": ["UK AI Opportunities Action Plan", "UK AI strategy 2026", "AI jobs UK government", "UK AI investment careers", "AI growth sectors UK"],
        "angle": "Break down the UK Government's AI Opportunities Action Plan. Explain the Growth Zones, public sector AI deployment commitments, skills investment, and what sectors will hire most. Link to practical qualification routes for professionals wanting to position themselves for this wave of AI investment.",
        "image_prompt": "UK government AI strategy, Houses of Parliament with futuristic AI cityscape, British flag with digital data streams, professional optimistic career growth visual, navy blue and gold with technological elements"
    },
    {
        "slug": "pearson-edexcel-vs-ncfe-higher-education-uk",
        "title": "Pearson Edexcel vs NCFE in UK Further and Higher Education: A 2026 Comparison",
        "tag": "Qualifications",
        "og_description": "Both Pearson Edexcel and NCFE are Ofqual-regulated awarding bodies. Understanding the differences helps UK learners make a better qualification choice.",
        "keywords": ["Pearson Edexcel vs NCFE", "UK awarding bodies comparison", "Edexcel NCFE difference", "Ofqual qualifications comparison", "UK regulated qualifications 2026"],
        "angle": "Detailed comparison of Pearson Edexcel and NCFE as awarding bodies: history, market share, employer relationships, university articulation agreements, digital delivery capabilities, and specific offerings in AI and data. Neither body is universally better; help readers identify which suits their specific goals.",
        "image_prompt": "UK further education and qualification comparison, professional learner reviewing options, modern college or university setting, diverse adult students, academic achievement imagery, navy and gold theme"
    },
    {
        "slug": "ai-ethics-career-path-uk-2026",
        "title": "AI Ethics and Governance: The UK Career Path No One Told You About",
        "tag": "AI Careers",
        "og_description": "AI ethics professionals are among the fastest-growing hires at UK tech firms and regulators. Here is what the role involves and how to break into it.",
        "keywords": ["AI ethics career UK", "AI governance jobs UK", "responsible AI UK careers", "AI safety roles UK", "AI ethics qualification UK"],
        "angle": "Deep dive into AI ethics and governance as a career. Cover: what the role involves, who is hiring (regulators, Big Tech, UK government, financial services), required skills (both technical and policy), salary data, and which qualifications help. Show the overlap with data science qualifications and how DAIS prepares learners.",
        "image_prompt": "AI ethics and responsible technology theme, balanced scales with AI chip and human figure, UK regulatory environment, professional thoughtful atmosphere, policy documents and technology combined, navy and gold professional palette"
    },
    {
        "slug": "ncfe-level-5-data-engineer-htq-uk",
        "title": "NCFE Level 5 Data Engineer HTQ: The Qualification UK Employers Are Asking For",
        "tag": "Course Review",
        "og_description": "Data engineering is one of the UK's most in-demand and highest-paying tech disciplines. The NCFE Level 5 HTQ is designed specifically for this role.",
        "keywords": ["NCFE Level 5 data engineer", "data engineering qualification UK", "HTQ Level 5 UK", "data engineer career UK 2026", "cloud data engineer qualification"],
        "angle": "Detailed look at the NCFE Level 5 Data Engineer HTQ. Cover the curriculum (cloud platforms, data pipelines, SQL, Python, Azure), assessment, time commitment, employer demand and salary data for data engineers in the UK, and how it compares to AWS/Azure certifications as a standalone route.",
        "image_prompt": "Senior data engineer working with cloud infrastructure and data pipelines, modern tech environment with multiple monitors showing code and data flow diagrams, professional UK tech office, sophisticated navy and gold colour scheme"
    },
    {
        "slug": "career-change-ai-uk-no-degree-guide",
        "title": "How to Break Into AI in the UK Without a Computer Science Degree",
        "tag": "Career Change",
        "og_description": "Thousands of UK professionals are moving into AI roles from unrelated backgrounds. Here is the realistic path, the qualifications that help, and what employers actually want.",
        "keywords": ["AI career without degree UK", "break into AI UK", "AI career change UK 2026", "non-technical AI career UK", "AI qualification no degree UK"],
        "angle": "Practical, honest guide for UK career changers. Address the degree question directly (many AI employers now care more about portfolio and regulated qualifications). Cover which AI roles are most accessible (data analyst, ML ops, AI product), the skills needed, the realistic timeline, and the role of NCFE qualifications in building credibility.",
        "image_prompt": "Career change and transition in UK tech sector, person confidently stepping forward on a new path surrounded by AI and data visualisations, London city skyline, optimistic professional atmosphere, warm navy and gold tones"
    },
    {
        "slug": "ai-in-uk-universities-2026-state-of-play",
        "title": "AI in UK Universities: How Higher Education Is Adapting and What It Means for Students",
        "tag": "HE and AI",
        "og_description": "UK universities are integrating AI into teaching, research, and administration. Here is what is actually changing, the concerns being raised, and what students should expect.",
        "keywords": ["AI in UK universities 2026", "AI higher education UK", "university AI policy UK", "AI tools students UK", "higher education AI integration UK"],
        "angle": "Evidence-based look at how UK HE is responding to AI. Cover: which universities are leading on AI curriculum, the ongoing debate about academic integrity and AI detection, AI teaching assistants, research applications, and what prospective students should look for. Include the perspective of working professionals considering postgrad.",
        "image_prompt": "UK university campus with AI technology integration, students and lecturers collaborating with AI tools, historic university architecture combined with futuristic digital elements, academic and technological harmony"
    },
    {
        "slug": "ofqual-recognition-vs-unrecognised-certificates-uk",
        "title": "Ofqual Recognition vs Unrecognised Certificates: How UK Employers Actually Decide",
        "tag": "Qualifications",
        "og_description": "Many online AI and data certificates look impressive but carry no regulatory weight. Here is how UK employers actually evaluate qualifications and what the difference is.",
        "keywords": ["Ofqual recognition employer UK", "unrecognised AI certificate UK", "fake AI qualification UK", "employer qualification check UK", "regulated vs unregulated UK"],
        "angle": "Investigative angle on the flood of AI and data certificates now available. Explain the difference between Ofqual-regulated and self-awarded certificates. Share employer perspectives on how they verify qualifications, the risks of certificates from overseas bodies, and what job listings actually specify. Build the case for regulated routes without being preachy.",
        "image_prompt": "Verification and authenticity theme, official UK qualification certificate with quality seal, professional HR or employer reviewing documents, trustworthy and authoritative imagery, navy blue and gold professional setting"
    },
    {
        "slug": "uk-apprenticeship-vs-online-qualification-ai",
        "title": "AI Apprenticeship vs Online Diploma: Which Is the Better Route for UK Professionals?",
        "tag": "Career Guide",
        "og_description": "Degree apprenticeships and online qualifications both promise AI careers. Here is an honest breakdown of the trade-offs so UK learners can make the right call.",
        "keywords": ["AI apprenticeship UK 2026", "data apprenticeship vs online course", "degree apprenticeship AI UK", "online AI qualification UK", "apprenticeship qualification comparison"],
        "angle": "Balanced comparison of levy-funded degree apprenticeships vs self-funded NCFE qualifications for AI and data. Cover: funding, flexibility, employer sponsorship needs, time to complete, learning quality, and career outcomes. Help working adults who cannot leave employment see the real options available to them.",
        "image_prompt": "UK professional dual path decision, apprenticeship and online study both leading to AI career, balanced decision-making imagery, modern UK workplace, professional adult learner, empowering and positive tone"
    },
    {
        "slug": "ncfe-level-3-tech-qualification-uk-school-leavers",
        "title": "NCFE Level 3 Technology Qualifications: The Fastest Route Into Tech Without A-Levels",
        "tag": "Career Guide",
        "og_description": "For UK school leavers without A-levels, NCFE Level 3 qualifications in data and AI offer a direct route to technology careers and university progression.",
        "keywords": ["NCFE Level 3 technology UK", "tech qualification no A-levels UK", "Level 3 data science UK", "school leaver tech career UK", "NCFE Level 3 review"],
        "angle": "Guide aimed at school leavers, parents, and career advisers. Explain what NCFE Level 3 qualifications deliver, how they compare to T-Levels and A-Levels for technology careers, university articulation options, and typical first roles for graduates. Include a 12-month study and career plan.",
        "image_prompt": "Young UK professional starting their technology career, confident school leaver or young adult with laptop and data visualisations, bright optimistic imagery, career launch atmosphere, navy and gold accents"
    },
    {
        "slug": "ai-for-non-technical-managers-uk-2026",
        "title": "AI for Non-Technical UK Managers: What You Need to Know and How to Upskill",
        "tag": "AI Tools",
        "og_description": "UK managers who understand AI are more effective leaders and better promotable candidates. Here is exactly what you need to learn and the fastest way to learn it.",
        "keywords": ["AI for managers UK", "non-technical AI upskilling UK", "AI leadership skills UK", "AI management training UK", "AI literacy UK professionals 2026"],
        "angle": "Practical guide for UK managers in finance, HR, operations, and marketing who need to understand AI without becoming data scientists. Cover what AI can and cannot do, how to manage AI projects, interpreting AI outputs critically, the risks of delegating to AI unsupervised, and which qualifications provide the right AI literacy.",
        "image_prompt": "Senior UK manager confidently leading AI strategy meeting, boardroom setting with AI dashboards, diverse executive team, authoritative yet approachable, modern British corporate environment, navy blue professional palette"
    },
    {
        "slug": "ncfe-cyber-security-career-uk-2026",
        "title": "NCFE Cyber Security Qualifications: Your Route to One of the UK's Most In-Demand Careers",
        "tag": "Cyber Security",
        "og_description": "The UK has a cyber security skills shortage. NCFE-regulated qualifications from Level 2 to Level 4 provide a clear, employer-recognised pathway into the field.",
        "keywords": ["NCFE cyber security UK", "cyber security qualification UK 2026", "cyber security career UK", "NCFE Level 4 cyber security", "cyber security jobs UK salary"],
        "angle": "Comprehensive guide to cyber security as a UK career, with NCFE qualifications as the pathway. Cover: the skills gap, UK government cyber roles, private sector demand, salary data, the path from Level 2 to Level 4, and specific NCFE cyber security unit content. Compare to CompTIA certifications for UK employer recognition.",
        "image_prompt": "UK cyber security professional in modern security operations centre, screens showing network monitoring and threat detection, professional authoritative environment, technological blue and navy imagery, secure and sophisticated atmosphere"
    },
    {
        "slug": "ai-machine-learning-salaries-uk-2026",
        "title": "AI and Machine Learning Salaries in the UK: The Complete 2026 Guide by Role and Region",
        "tag": "Salaries and Jobs",
        "og_description": "AI salaries in the UK range from £35,000 to over £150,000. Here is a detailed breakdown by role, experience level, sector, and UK city.",
        "keywords": ["AI salary UK 2026", "machine learning engineer salary UK", "data scientist salary UK 2026", "AI engineer pay UK", "AI jobs salary London Manchester"],
        "angle": "Data-driven salary guide covering: AI engineer, ML engineer, data scientist, AI researcher, AI product manager, AI ethicist, and MLOps engineer. Break down by experience level (junior/mid/senior/principal) and by geography (London, Manchester, Edinburgh, Leeds, Bristol, remote). Discuss the premium that formal qualifications and portfolio work commands.",
        "image_prompt": "Professional AI career salary growth visualisation, upward trending career chart, UK city skylines in background, successful diverse tech professionals, motivational and aspirational tone, gold and navy professional colour palette"
    },
    {
        "slug": "pearson-btec-tech-vs-degree-uk-employers",
        "title": "Pearson BTEC Technology Qualifications: Do UK Employers Still Respect Them in 2026?",
        "tag": "Qualifications",
        "og_description": "BTEC qualifications from Pearson are widely held but the employer landscape is changing. Here is an honest look at how BTECs are viewed in the 2026 UK job market.",
        "keywords": ["Pearson BTEC employer recognition 2026", "BTEC technology UK employers", "BTEC vs degree employers", "BTEC data science employer view", "BTEC qualification value UK"],
        "angle": "Honest, research-backed look at the current standing of Pearson BTEC qualifications with UK employers, particularly in technology. Cover sectors that value them, sectors that have moved toward degree requirements, how BTECs interact with university applications post-A-Level reform, and what this means for learners choosing a qualification route.",
        "image_prompt": "Professional UK qualification evaluation, employer and professional reviewing credentials, UK business setting, corporate and educational imagery combined, thoughtful and informative atmosphere, clean navy and gold visual"
    },
    {
        "slug": "ai-in-uk-financial-services-career-opportunities",
        "title": "AI in UK Financial Services: Career Opportunities for Data and Technology Professionals",
        "tag": "AI Careers",
        "og_description": "UK banks, insurers, and fintechs are the biggest hirers of AI talent outside Big Tech. Here is where the jobs are and how to position yourself.",
        "keywords": ["AI jobs financial services UK", "fintech AI career UK", "AI banking UK 2026", "data science finance UK", "AI insurance careers UK"],
        "angle": "Deep dive into AI adoption in UK financial services. Cover specific use cases (fraud detection, credit scoring, compliance monitoring, customer service AI), the roles being created, which firms are hiring most, salary benchmarks versus other sectors, and what regulatory knowledge (FCA, Basel) makes candidates more valuable.",
        "image_prompt": "UK financial district with AI technology, Canary Wharf or City of London skyline with digital data overlay, professional financial technology analyst, screens showing financial data and AI models, sophisticated and authoritative"
    },
    {
        "slug": "free-ai-courses-uk-vs-paid-qualifications",
        "title": "Free AI Courses vs Paid UK Qualifications: What You Actually Get for Your Money",
        "tag": "Career Guide",
        "og_description": "Free AI courses on Coursera, edX, and YouTube are useful, but they are not the same as regulated UK qualifications. Here is an honest comparison.",
        "keywords": ["free AI course UK vs paid", "Coursera vs NCFE UK", "AI qualification value UK", "is paid AI course worth it UK", "free AI certification UK employer"],
        "angle": "Balanced comparison addressing the genuine question many learners have: why pay for a qualification when free resources exist? Cover: what free courses actually deliver (knowledge, no credential), how employers view them compared to regulated qualifications, the role of assessment and external verification, and when each makes sense.",
        "image_prompt": "Learning investment decision visual, scale comparing free online learning with professional UK qualification, career return on investment concept, thoughtful professional learner, UK career environment, clear and educational imagery"
    },
    {
        "slug": "ai-healthcare-uk-career-data-professionals",
        "title": "AI in UK Healthcare: How Data Professionals Can Break Into the NHS and Beyond",
        "tag": "AI Careers",
        "og_description": "The NHS and private healthcare in the UK are investing heavily in AI. Here are the roles being created, the qualifications that help, and the entry routes.",
        "keywords": ["AI NHS career UK", "healthcare AI jobs UK 2026", "clinical data scientist UK", "AI healthcare qualification UK", "NHS data roles 2026"],
        "angle": "Career guide for professionals interested in AI in healthcare. Cover NHS Digital and the transformation agenda, specific roles (clinical informatics, healthcare data analyst, AI clinical safety officer), required qualifications and clearances, salary benchmarks vs commercial sector, and the unique ethical considerations. Show how NCFE data qualifications serve as entry points.",
        "image_prompt": "AI technology in UK healthcare environment, medical data visualisation on hospital screens, professional healthcare and technology professional, NHS blue combined with tech imagery, careful and authoritative atmosphere"
    },
    {
        "slug": "ncfe-coding-qualification-uk-beginners",
        "title": "NCFE Coding Qualifications: The Best Starting Point for UK Beginners in 2026",
        "tag": "Career Guide",
        "og_description": "NCFE offers coding qualifications from Level 2 upwards. For UK beginners with no technical background, they offer a structured, regulated entry point into technology.",
        "keywords": ["NCFE coding qualification UK", "learn to code qualification UK", "beginners coding course UK 2026", "NCFE Level 2 coding", "coding qualification for adults UK"],
        "angle": "Guide for absolute beginners in the UK who want to start coding but feel intimidated. Cover what NCFE coding qualifications teach, how they compare to bootcamps and self-learning, the realistic time commitment, what jobs open up after Level 2 and Level 3, and how they connect to the broader DAIS qualification pathway.",
        "image_prompt": "Beginner coder on their first steps into technology, welcoming and approachable learning environment, UK adult learner at laptop with code on screen, encouraging and positive imagery, bright and accessible educational setting"
    },
    {
        "slug": "micro-credentials-vs-diplomas-ai-uk",
        "title": "Micro-Credentials vs Full Diplomas for AI Careers in the UK: Which Gets You Hired?",
        "tag": "Qualifications",
        "og_description": "Short AI badges and micro-credentials are popular but do they actually carry weight with UK employers? Here is what the evidence shows.",
        "keywords": ["micro-credential AI UK", "AI badge vs diploma UK", "short AI course employer UK", "full diploma vs certificate AI UK", "AI qualification depth UK"],
        "angle": "Evidence-led comparison of micro-credentials (LinkedIn Learning badges, Google certificates, Coursera specialisations) versus full regulated diplomas for UK AI careers. Cover employer survey data, which roles require depth of knowledge vs breadth, the portfolio argument, and why the volume of micro-credentials is diluting their value.",
        "image_prompt": "Qualification depth comparison visual, collection of badges versus substantial diploma certificate, UK career progression, professional thoughtful imagery, quality versus quantity concept, clean professional aesthetic"
    },
    {
        "slug": "ai-skills-gap-uk-2026-employer-survey",
        "title": "The UK AI Skills Gap in 2026: What Employers Are Looking For and Cannot Find",
        "tag": "AI Careers",
        "og_description": "UK employers report a significant AI skills shortage. Understanding exactly what is missing reveals the most valuable skills for professionals to develop right now.",
        "keywords": ["UK AI skills gap 2026", "AI skills shortage UK employers", "AI talent gap UK", "what employers want AI UK", "AI skills in demand UK 2026"],
        "angle": "Research-led article on the AI skills shortage in the UK. Cover specific skills identified as scarce (ML engineering, data engineering, AI product management, applied AI), which sectors are most affected, what this means for salary premium, how the shortage creates an entry window for qualified professionals, and what NCFE qualifications address the gap.",
        "image_prompt": "UK talent and skills demand visual, employers searching for AI professionals, job market supply and demand concept, UK tech hiring environment, professional recruitment atmosphere, urgency and opportunity combined"
    },
    {
        "slug": "ofqual-2026-qualification-reform-uk-learners",
        "title": "Ofqual's 2026 Qualification Review: What Is Changing and What It Means for UK Learners",
        "tag": "Qualifications",
        "og_description": "Ofqual is reviewing its qualification landscape in 2026. These changes will affect which courses remain funded, recognised, and worth pursuing.",
        "keywords": ["Ofqual 2026 changes UK", "qualification reform UK 2026", "Ofqual review impact learners", "UK qualification changes 2026", "Ofqual landscape 2026"],
        "angle": "Timely explainer on Ofqual's ongoing qualification reform process. Cover what is being reviewed, which qualification types face defunding risk, the T-Level vs BTEC tension, how technical qualifications at Level 3 and above are being rationalised, and what learners should look for to future-proof their qualification choice.",
        "image_prompt": "UK education policy and reform visual, official government documents and education policy setting, professional policy environment, UK Parliament and education institutions, authoritative and clear informational imagery"
    },
    {
        "slug": "university-vs-ncfe-level-5-ai-uk-roi",
        "title": "University Degree vs NCFE Level 5 Diploma for AI in the UK: Which Gives Better ROI?",
        "tag": "Career Guide",
        "og_description": "A three-year UK university degree costs over £27,000 in tuition alone. Here is an honest comparison with the NCFE Level 5 HTQ route for AI careers.",
        "keywords": ["university vs diploma AI UK", "NCFE Level 5 vs degree UK", "AI qualification ROI UK", "degree alternative UK AI", "HTQ vs university UK"],
        "angle": "Financial and career ROI comparison between a full UK undergraduate AI or data science degree versus the NCFE Level 5 HTQ route. Cover total cost, time to employment, starting salaries, employer perception over 5 and 10 years, university progression options, and the student loan burden. Honest about the limitations of both routes.",
        "image_prompt": "UK education investment comparison, university campus on one side, professional tech workplace on other, career ROI concept, financial and career outcome visualisation, thoughtful decision-making imagery, balanced perspective"
    },
    {
        "slug": "ai-product-management-career-uk-2026",
        "title": "AI Product Management in the UK: The Emerging Career No One Is Talking About",
        "tag": "AI Careers",
        "og_description": "AI product managers sit between data science teams and business stakeholders. It is one of the UK's fastest-growing tech roles and one of the best paid.",
        "keywords": ["AI product manager UK", "AI PM career UK 2026", "product management AI roles UK", "AI product management skills UK", "AI PM salary UK"],
        "angle": "Profile of AI product management as a career. What the role involves (translating AI capability into product decisions), required skills (both technical and commercial), UK salary data, which companies are hiring, and how professionals from adjacent roles (traditional PM, data analyst, business analyst) can transition. Show which DAIS qualifications provide the analytical foundation.",
        "image_prompt": "AI product manager leading cross-functional team meeting, UK tech company environment, diverse professional team around whiteboard with AI product roadmap, strategic and collaborative atmosphere, modern London tech office setting"
    },
    {
        "slug": "ncfe-cloud-systems-qualification-uk-azure",
        "title": "NCFE Cloud Systems and Secure Networking HTQ: The Qualification for UK Cloud Careers",
        "tag": "Course Review",
        "og_description": "The NCFE Level 5 HTQ in Cloud Systems and Secure Networking targets one of the UK's most in-demand and highest-paying technology disciplines.",
        "keywords": ["NCFE cloud qualification UK", "cloud systems HTQ UK", "Level 5 cloud networking UK", "Azure qualification UK 2026", "cloud networking career UK"],
        "angle": "Detailed review of the NCFE Level 5 HTQ in Cloud Systems and Secure Networking. Cover the curriculum (Azure architecture, network security, DevSecOps, infrastructure as code), how it compares to standalone vendor certifications (AZ-900, AZ-104), employer demand and salary data for cloud roles, and who the ideal learner profile is.",
        "image_prompt": "Cloud computing professional in UK data centre or modern tech environment, server infrastructure with cloud connectivity visualisation, secure networking concept, professional technical atmosphere, authoritative and skilled professional imagery"
    },
    {
        "slug": "ai-accessibility-inclusive-education-uk",
        "title": "AI and Inclusive Education in the UK: Opportunities for Disabled and Neurodiverse Learners",
        "tag": "HE and AI",
        "og_description": "AI tools are transforming accessibility in UK education. Here is how disabled and neurodiverse learners can benefit, and which qualifications are most flexible.",
        "keywords": ["AI inclusive education UK", "disabled learners AI UK", "neurodiverse online learning UK", "flexible AI qualification UK", "AI accessibility education"],
        "angle": "Important and underserved topic. Cover how AI tools (text-to-speech, grammar AI, summarisation) help disabled and neurodiverse UK learners, how online qualification delivery (like DAIS) removes physical barriers, the Disability Confident employer scheme and how qualifications interact with it, and the portfolio-based assessment advantage for learners who struggle with timed exams.",
        "image_prompt": "Inclusive and accessible UK education environment, diverse learners including wheelchair user at laptop, AI assistive technology, welcoming and empowering atmosphere, technology enabling participation, warm and inclusive visual"
    },
]


BASE_URL    = "https://www.dataaischool.com"
REPO_ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOG_DIR    = os.path.join(REPO_ROOT, "blog")
IMAGES_DIR  = os.path.join(REPO_ROOT, "images")
SITEMAP_PATH = os.path.join(REPO_ROOT, "sitemap.xml")
BLOG_HTML_PATH = os.path.join(REPO_ROOT, "blog.html")
TOPICS_USED_PATH = os.path.join(BLOG_DIR, "BLOG_TOPICS_USED.json")

TODAY = datetime.date.today().isoformat()


# ---------------------------------------------------------------------------
# Topic selection
# ---------------------------------------------------------------------------
def pick_topic():
    used = []
    if os.path.exists(TOPICS_USED_PATH):
        with open(TOPICS_USED_PATH) as f:
            used = json.load(f)
    used_slugs = {t["slug"] if isinstance(t, dict) else t for t in used}
    for topic in TOPIC_QUEUE:
        if topic["slug"] not in used_slugs:
            return topic
    print("All topics used. Resetting rotation.")
    return TOPIC_QUEUE[0]


def mark_topic_used(topic):
    used = []
    if os.path.exists(TOPICS_USED_PATH):
        with open(TOPICS_USED_PATH) as f:
            used = json.load(f)
    if not used or not isinstance(used[0], dict):
        used = [{"slug": s} for s in used]
    if not any(t["slug"] == topic["slug"] for t in used):
        used.append({"slug": topic["slug"], "published": TODAY})
    with open(TOPICS_USED_PATH, "w") as f:
        json.dump(used, f, indent=2)


# ---------------------------------------------------------------------------
# Blog content generation via Claude Sonnet
# ---------------------------------------------------------------------------
def generate_blog_content(topic):
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    prompt = f"""You are Ali Fraz Khan, FHEA, CEO and Principal of The Data and AI School of London (DAIS),
a UK online specialist school delivering Ofqual-regulated NCFE qualifications in Data Science, AI, Cloud Engineering,
and Cyber Security at RQF Levels 2 to 5. You are writing a blog post for www.dataaischool.com.

MANDATORY RULES:
- Write in British English throughout. Use "programme", "recognised", "analyse", "organisation", etc.
- NEVER use em dashes or en dashes. Use commas, colons, or hyphens only.
- Tone: professional, authoritative, warm, and direct. No filler phrases.
- Write for working UK professionals considering upskilling or career change.
- Every article must include internal links to at least two existing DAIS blog posts:
    - what-is-data-science-uk-guide.html
    - what-is-agentic-ai-explained.html
    - why-everyone-needs-to-learn-ai-implementation.html
    - getting-started-with-python-for-data-science.html
    - will-ai-replace-data-scientists-uk-2026.html
- Include at least one CTA linking to ../courses.html or ../apply.html
- Do NOT use markdown. Write only clean HTML for the blog body (no html, head, or body tags).
- Structure: h2 and h3 headings, p tags, ul/ol lists, one comparison table (inline styled borders),
  one blockquote with a key insight, and a clear CTA div at the end.
- Minimum 1,400 words of actual content.
- Be specific and practical. Cite UK-specific facts, salary figures, employer trends, and regulatory context.
- Do not mention "Data SciKit AI Ltd" or any previous school names.
- Make it genuinely useful and shareable on LinkedIn.

TOPIC: {topic['title']}

WRITING ANGLE: {topic['angle']}

KEYWORDS TO INCLUDE NATURALLY (do not keyword-stuff):
{', '.join(topic['keywords'])}

Write only the blog body HTML, starting with a <p> tag and ending after the CTA div."""

    payload = json.dumps({
        "model": "claude-sonnet-4-6",
        "max_tokens": 5000,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST"
    )
    tls_ctx = ssl.create_default_context()
    tls_ctx.check_hostname = True
    tls_ctx.verify_mode = ssl.CERT_REQUIRED
    with urllib.request.urlopen(req, timeout=120, context=tls_ctx) as resp:
        data = json.load(resp)
    raw_html = data["content"][0]["text"]
    return sanitise_blog_html(raw_html)


# ---------------------------------------------------------------------------
# HTML sanitiser for LLM output (prevents stored XSS from prompt injection)
# ---------------------------------------------------------------------------
_ALLOWED_TAGS = {
    "p", "br", "strong", "b", "em", "i", "u", "s",
    "h2", "h3", "h4",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "img",
    "div", "span", "details", "summary",
    "time", "figcaption", "figure",
}

_DANGEROUS_ATTRS = re.compile(r'\s+on\w+\s*=', re.IGNORECASE)
_DANGEROUS_URLS  = re.compile(r'href\s*=\s*["\']?\s*javascript:', re.IGNORECASE)
_SCRIPT_TAG      = re.compile(r'<\s*script[\s>].*?</\s*script\s*>', re.IGNORECASE | re.DOTALL)
_STYLE_TAG       = re.compile(r'<\s*style[\s>].*?</\s*style\s*>',   re.IGNORECASE | re.DOTALL)
_IFRAME_TAG      = re.compile(r'<\s*iframe[\s>].*?</\s*iframe\s*>', re.IGNORECASE | re.DOTALL)
_BASE_TAG        = re.compile(r'<\s*base[\s>][^>]*>', re.IGNORECASE)
_FORM_TAG        = re.compile(r'<\s*form[\s>].*?</\s*form\s*>',     re.IGNORECASE | re.DOTALL)


def sanitise_blog_html(html: str) -> str:
    html = _SCRIPT_TAG.sub('', html)
    html = _STYLE_TAG.sub('', html)
    html = _IFRAME_TAG.sub('', html)
    html = _BASE_TAG.sub('', html)
    html = _FORM_TAG.sub('', html)
    html = _DANGEROUS_ATTRS.sub(' data-removed=', html)
    html = _DANGEROUS_URLS.sub('href="about:blank"', html)
    unknown = re.findall(r'<(\w+)', html)
    for tag in set(unknown):
        if tag.lower() not in _ALLOWED_TAGS:
            print(f"WARNING: Unexpected HTML tag in LLM output: <{tag}>")
    return html


# ---------------------------------------------------------------------------
# Hero image: Google Imagen 3 (contextual) with Pillow fallback
# ---------------------------------------------------------------------------
def generate_hero_image_imagen(topic, gemini_key):
    """Generate a contextual 16:9 hero image via Google Imagen 3."""
    if not GOOGLE_GENAI_AVAILABLE:
        raise RuntimeError("google-genai package not installed")

    slug = topic["slug"]
    fname = f"blog-{slug}.png"
    out_path = os.path.join(IMAGES_DIR, fname)

    prompt = (
        f"Professional hero image for a UK education and technology blog article: '{topic['title']}'. "
        f"{topic.get('image_prompt', 'Modern UK professional education and technology setting, navy blue and gold colour scheme')}. "
        "Photorealistic, high quality, corporate professional style. "
        "No text, no words, no logos in the image."
    )

    client = google_genai.Client(api_key=gemini_key)
    response = client.models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt[:2000],
        config=google_genai_types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="16:9",
        )
    )

    image_bytes = response.generated_images[0].image.image_bytes
    with open(out_path, "wb") as f:
        f.write(image_bytes)
    size_kb = os.path.getsize(out_path) // 1024
    print(f"Imagen 3 image saved: {fname} ({size_kb}KB)")
    return fname


def generate_hero_image_pillow(topic):
    """Branded fallback image using Pillow when Imagen 3 is unavailable."""
    if not PIL_AVAILABLE:
        return None

    slug = topic["slug"]
    fname = f"blog-{slug}.png"
    out_path = os.path.join(IMAGES_DIR, fname)

    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (8, 20, 60))
    draw = ImageDraw.Draw(img)

    for y in range(H):
        t = y / H
        draw.line([(0, y), (W, y)], fill=(int(8 + t*15), int(20 + t*25), int(60 + t*20)))
    for x in range(0, W, 60):
        draw.line([(x, 0), (x, H)], fill=(16, 38, 85))
    for y in range(0, H, 60):
        draw.line([(0, y), (W, y)], fill=(16, 38, 85))

    try:
        fbold   = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 44)
        fbold_s = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 32)
        fsub    = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
        ftag    = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
        fbrand  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    except Exception:
        fbold = fbold_s = fsub = ftag = fbrand = ImageFont.load_default()

    draw.rectangle([0, 582, W, 630], fill=(10, 24, 68))
    draw.rectangle([0, 578, W, 582], fill=(215, 162, 35))

    tag_text = topic["tag"].upper()
    draw.rounded_rectangle([40, 55, 40 + len(tag_text)*9 + 24, 83], radius=11, fill=(170, 120, 15))
    draw.text((52, 61), tag_text, fill=(255, 240, 195), font=ftag)

    title = topic["title"]
    lines, cur = [], ""
    for w in title.split():
        test = (cur + " " + w).strip()
        if len(test) > 40 and cur:
            lines.append(cur)
            cur = w
        else:
            cur = test
    if cur:
        lines.append(cur)

    colors = [(255,255,255), (95,195,255), (255,255,255), (210,210,210)]
    for i, line in enumerate(lines[:4]):
        draw.text((40, 100 + i * 60), line, fill=colors[i % len(colors)],
                  font=(fbold if i < 2 else fbold_s))

    sub_lines = textwrap.wrap(topic["og_description"][:120], width=62)
    for i, sl in enumerate(sub_lines[:3]):
        draw.text((40, 360 + i * 28), sl, fill=(185, 185, 185), font=fsub)

    draw.text((40, 596), "The Data and AI School of London", fill=(215, 162, 35), font=fbrand)
    draw.text((W - 242, 596), "www.dataaischool.com", fill=(155, 175, 215), font=fbrand)

    img.save(out_path, "PNG")
    size_kb = os.path.getsize(out_path) // 1024
    print(f"Pillow fallback image saved: {fname} ({size_kb}KB)")
    return fname


def generate_hero_image(topic):
    """Try Imagen 3 first; fall back to Pillow if key is absent or call fails."""
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if gemini_key:
        try:
            return generate_hero_image_imagen(topic, gemini_key)
        except Exception as exc:
            print(f"Imagen 3 failed ({exc}). Falling back to Pillow.")
    else:
        print("GEMINI_API_KEY not set. Using Pillow fallback image.")
    return generate_hero_image_pillow(topic)


# ---------------------------------------------------------------------------
# HTML assembly
# ---------------------------------------------------------------------------
def build_html(topic, body_html, image_filename):
    slug         = topic["slug"]
    title        = topic["title"]
    og_desc      = topic["og_description"]
    tag          = topic["tag"]
    url          = f"{BASE_URL}/blog/{slug}.html"
    img_url      = f"{BASE_URL}/images/{image_filename}" if image_filename else f"{BASE_URL}/images/og-default.jpg"
    date_display = datetime.date.today().strftime("%-d %b %Y")
    date_iso     = TODAY
    keywords_json = json.dumps(topic["keywords"])
    enc_url      = urllib.parse.quote(url, safe="")
    enc_title    = urllib.parse.quote(title, safe="")

    share_btns = f"""<div class="blog-share">
  <div class="blog-share-inner">
    <span class="blog-share-label">Share this article</span>
    <div class="blog-share-btns">
      <a href="https://www.facebook.com/sharer/sharer.php?u={enc_url}" class="blog-share-btn blog-share-facebook" target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg><span>Facebook</span></a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url={enc_url}" class="blog-share-btn blog-share-linkedin" target="_blank" rel="noopener noreferrer" aria-label="Share on LinkedIn"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg><span>LinkedIn</span></a>
      <a href="https://twitter.com/intent/tweet?url={enc_url}&text={enc_title}" class="blog-share-btn blog-share-twitter" target="_blank" rel="noopener noreferrer" aria-label="Share on X"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg><span>X</span></a>
      <a href="https://wa.me/?text={enc_title}%20{enc_url}" class="blog-share-btn blog-share-whatsapp" target="_blank" rel="noopener noreferrer" aria-label="Share on WhatsApp"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg><span>WhatsApp</span></a>
      <button type="button" class="blog-share-btn blog-share-copy" onclick="(function(b){{var u='{url}';if(navigator.clipboard){{navigator.clipboard.writeText(u).then(function(){{var s=b.querySelector('span');var o=s.textContent;s.textContent='Copied!';b.classList.add('blog-share-copied');setTimeout(function(){{s.textContent=o;b.classList.remove('blog-share-copied')}},2000)}})}}}})(this)" aria-label="Copy link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg><span>Copy link</span></button>
    </div>
  </div>
</div>"""

    img_tag = f'../images/{image_filename}' if image_filename else '../images/og-default.jpg'

    return f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title} | The Data and AI School of London</title>
<meta name="description" content="{og_desc}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="{url}">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://dais-chat.alifrazkhan92.workers.dev; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';">
<meta http-equiv="X-Content-Type-Options" content="nosniff">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta property="og:type" content="article">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{og_desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{img_url}">
<meta property="og:image:width" content="1792">
<meta property="og:image:height" content="1024">
<meta property="og:site_name" content="The Data and AI School of London">
<meta property="article:published_time" content="{date_iso}">
<meta property="article:author" content="Ali Fraz Khan">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{og_desc}">
<meta name="twitter:image" content="{img_url}">
<link rel="icon" type="image/svg+xml" href="../images/favicon.svg" />
<link rel="icon" type="image/png" sizes="64x64" href="../images/favicon-64.png" />
<link rel="icon" type="image/png" sizes="32x32" href="../favicon.png" />
<link rel="apple-touch-icon" sizes="180x180" href="../images/apple-touch-icon.png" />
<link rel="stylesheet" href="../css/styles.css" />
<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{title}",
  "description": "{og_desc}",
  "image": "{img_url}",
  "datePublished": "{date_iso}",
  "dateModified": "{date_iso}",
  "author": [{{
    "@type": "Person",
    "name": "Ali Fraz Khan",
    "honorificSuffix": "FHEA",
    "jobTitle": "CEO and Principal",
    "worksFor": {{"@type": "Organization", "name": "The Data and AI School of London"}}
  }}],
  "publisher": {{
    "@type": "EducationalOrganization",
    "@id": "{BASE_URL}/#organisation",
    "name": "The Data and AI School of London",
    "logo": {{"@type": "ImageObject", "url": "{BASE_URL}/images/logo-dais.png"}}
  }},
  "mainEntityOfPage": "{url}",
  "keywords": {keywords_json},
  "breadcrumb": {{
    "@type": "BreadcrumbList",
    "itemListElement": [
      {{"@type": "ListItem", "position": 1, "name": "Home", "item": "{BASE_URL}/"}},
      {{"@type": "ListItem", "position": 2, "name": "Blog", "item": "{BASE_URL}/blog.html"}},
      {{"@type": "ListItem", "position": 3, "name": "{title}", "item": "{url}"}}
    ]
  }}
}}
</script>
</head>
<body>
<div id="site-nav"></div>
<script src="../js/navbar.js"></script>

<main>
  <article class="blog-post">
    <nav aria-label="Breadcrumb" style="margin-bottom:1.5rem;font-size:0.875rem;color:var(--text-muted)">
      <a href="../index.html">Home</a> &rsaquo; <a href="../blog.html">Blog</a> &rsaquo; <span>{title}</span>
    </nav>

    <header class="blog-post-header">
      <div class="blog-card-meta">
        <span class="blog-tag">{tag}</span>
        <time class="blog-date" datetime="{date_iso}">{date_display}</time>
        <span class="blog-read-time">10 min read</span>
      </div>
      <h1>{title}</h1>
      <div class="blog-post-meta">
        <span class="blog-author">By <strong>Ali Fraz Khan, FHEA</strong>, CEO &amp; Principal, The Data and AI School of London</span>
      </div>
      <img
        src="{img_tag}"
        alt="{title}"
        width="1792"
        height="1024"
        style="width:100%;height:auto;border-radius:var(--radius-lg);margin-bottom:1.5rem;"
        loading="eager"
      />
    </header>

    {share_btns}

    <div class="blog-post-body">
      {body_html}
    </div>

    {share_btns.replace('Share this article', 'Found this useful? Share it')}

  </article>
</main>

<footer class="site-footer">
  <div class="footer-inner">
    <p>&copy; {datetime.date.today().year} The Data and AI School of London. All rights reserved. &nbsp;|&nbsp; <a href="tel:+442070990956">+44 207 0990 956</a> &nbsp;|&nbsp; ICO Registration: <strong>ZC086597</strong></p>
    <ul class="footer-nav">
      <li><a href="../about.html">About</a></li>
      <li><a href="../courses.html">Courses</a></li>
      <li><a href="../blog.html">Blog</a></li>
      <li><a href="../apply.html">Apply</a></li>
      <li><a href="../contact.html">Contact</a></li>
      <li><a href="../privacy-policy.html">Privacy Policy</a></li>
      <li><a href="https://learn.dataaischool.com" target="_blank" rel="noopener noreferrer">Student Portal</a></li>
    </ul>
  </div>
</footer>

<script src="../js/main.js"></script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Sitemap update
# ---------------------------------------------------------------------------
def update_sitemap(slug):
    url_entry = f"""  <url>
    <loc>{BASE_URL}/blog/{slug}.html</loc>
    <lastmod>{TODAY}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
"""
    with open(SITEMAP_PATH) as f:
        content = f.read()
    if f"{slug}.html" in content:
        print("Sitemap already contains this slug. Skipping.")
        return
    content = content.replace("</urlset>", url_entry + "</urlset>")
    with open(SITEMAP_PATH, "w") as f:
        f.write(content)
    print("Sitemap updated.")


# ---------------------------------------------------------------------------
# blog.html listing update
# ---------------------------------------------------------------------------
def update_blog_listing(topic, image_filename):
    slug         = topic["slug"]
    title        = topic["title"]
    og_desc      = topic["og_description"]
    tag          = topic["tag"]
    date_display = datetime.date.today().strftime("%-d %b %Y")
    date_iso     = TODAY
    img_src      = f"images/{image_filename}" if image_filename else "images/og-default.jpg"

    card = f"""
 <!-- {slug} (auto-generated {date_iso}) -->
 <article class="blog-card">
 <div class="blog-card-img">
   <img src="{img_src}" alt="{title}" loading="lazy"/>
 </div>
 <div class="blog-card-body">
   <div class="blog-card-meta">
     <span class="blog-tag">{tag}</span>
     <time class="blog-date" datetime="{date_iso}">{date_display}</time>
     <span class="blog-read-time">10 min read</span>
   </div>
   <h2><a href="blog/{slug}.html">{title}</a></h2>
   <p>{og_desc}</p>
   <div class="blog-card-footer">
     <span class="blog-author">Ali Fraz Khan, FHEA</span>
     <a href="blog/{slug}.html" class="blog-read-more">Read more &#8594;</a>
   </div>
 </div>
 </article>
"""

    with open(BLOG_HTML_PATH) as f:
        content = f.read()

    if slug in content:
        print("blog.html already contains this post. Skipping.")
        return

    # Insert after the opening of blog-grid
    marker = '<div class="blog-grid"'
    idx = content.find(marker)
    if idx == -1:
        print("WARNING: Could not find blog-grid marker in blog.html. Skipping listing update.")
        return

    # Find the end of that opening tag
    tag_end = content.find('>', idx) + 1
    content = content[:tag_end] + card + content[tag_end:]

    with open(BLOG_HTML_PATH, "w") as f:
        f.write(content)
    print("blog.html listing updated.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"DAIS Weekly Blog Generator - {TODAY}")

    topic = pick_topic()
    print(f"Selected topic: {topic['title']}")

    slug      = topic["slug"]
    html_path = os.path.join(BLOG_DIR, f"{slug}.html")

    if os.path.exists(html_path):
        print(f"Blog post already exists: {html_path}. Skipping.")
        sys.exit(0)

    print("Generating hero image...")
    img_file = generate_hero_image(topic)

    print("Generating blog content via Claude Sonnet...")
    body_html = generate_blog_content(topic)

    print("Assembling HTML...")
    html = build_html(topic, body_html, img_file)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Blog post written: {html_path}")

    update_sitemap(slug)
    update_blog_listing(topic, img_file)
    mark_topic_used(topic)

    print("Done.")


if __name__ == "__main__":
    main()
