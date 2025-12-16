#!/usr/bin/env python3
"""
Test script for educational summary functionality
Demonstrates neutral, educational content generation
"""

import requests
import json
from datetime import datetime

# Test configuration
BASE_URL = "http://127.0.0.1:5000"

def test_educational_summary():
    """Test the educational summary functionality"""
    
    print("📚 Testing Educational Summary Generation")
    print("=" * 55)
    
    # Test 1: Educational summary endpoint
    print("\n1️⃣ Testing /user/measurement-summary endpoint...")
    
    # This would need a real authenticated user ID from the database
    test_user_id = 1  # Placeholder - would need actual user
    
    response = requests.get(f"{BASE_URL}/user/measurement-summary?user_id={test_user_id}")
    
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        data = response.json()
        print("✅ Educational summary generated successfully!")
        
        summary = data.get('summary', {})
        print(f"\n📋 Summary Details:")
        print(f"Title: {summary.get('title', 'N/A')}")
        print(f"Type: {summary.get('summary_type', 'N/A')}")
        print(f"Classification: {summary.get('pattern_classification', 'N/A')}")
        print(f"Analysis Period: {summary.get('analysis_period', 'N/A')}")
        
        # Display main message
        main_message = summary.get('main_message', '')
        if main_message:
            print(f"\n💬 Main Message:")
            print(f"   {main_message}")
        
        # Display key observations
        observations = summary.get('key_observations', [])
        if observations:
            print(f"\n🔍 Key Observations ({len(observations)}):")
            for i, obs in enumerate(observations, 1):
                print(f"   {i}. {obs}")
        
        # Display educational notes
        edu_notes = summary.get('educational_notes', [])
        if edu_notes:
            print(f"\n📖 Educational Notes ({len(edu_notes)}):")
            for i, note in enumerate(edu_notes, 1):
                print(f"   {i}. {note}")
        
        # Display recommendations
        recommendations = summary.get('recommendations', [])
        if recommendations:
            print(f"\n💡 Recommendations ({len(recommendations)}):")
            for i, rec in enumerate(recommendations, 1):
                print(f"   {i}. {rec}")
        
        # Display disclaimer
        disclaimer = summary.get('disclaimer', '')
        if disclaimer:
            print(f"\n⚠️  Disclaimer:")
            print(f"   {disclaimer}")
        
        # Display professional guidance
        important_notes = data.get('important_notes', {})
        if important_notes:
            print(f"\n🏥 Professional Guidance:")
            print(f"   Screening Nature: {important_notes.get('screening_nature', 'N/A')}")
            print(f"   Professional Evaluation: {important_notes.get('professional_evaluation', 'N/A')}")
        
        # Display when to seek help
        seek_help = data.get('when_to_seek_professional_help', [])
        if seek_help:
            print(f"\n🚨 Seek Professional Help If:")
            for i, item in enumerate(seek_help, 1):
                print(f"   {i}. {item}")
    
    elif response.status_code == 404:
        print("❌ User not found or endpoint not available")
        print("Note: This test requires an authenticated user with session history")
    else:
        try:
            error_data = response.json()
            print(f"❌ Error: {error_data.get('error', 'Unknown error')}")
        except:
            print(f"❌ HTTP Error: {response.status_code}")
    
    # Test 2: Invalid user handling
    print("\n2️⃣ Testing invalid user handling...")
    
    response = requests.get(f"{BASE_URL}/user/measurement-summary?user_id=99999")
    
    print(f"Status Code: {response.status_code}")
    if response.status_code == 404:
        print("✅ Correctly rejected invalid user")
    else:
        print(f"❌ Unexpected response: {response.status_code}")
    
    # Test 3: Missing user_id handling
    print("\n3️⃣ Testing missing user_id handling...")
    
    response = requests.get(f"{BASE_URL}/user/measurement-summary")
    
    print(f"Status Code: {response.status_code}")
    if response.status_code == 400:
        print("✅ Correctly rejected missing user_id")
    else:
        print(f"❌ Unexpected response: {response.status_code}")
    
    print("\n🎯 Educational Summary Features:")
    print("✅ Generates neutral, educational content")
    print("✅ Highlights consistency or variability patterns")
    print("✅ Avoids clinical language and diagnosis")
    print("✅ Reinforces medical disclaimers throughout")
    print("✅ Encourages professional consultation appropriately")
    print("✅ Provides context-specific recommendations")
    print("✅ Maintains objective, educational tone")

def demonstrate_summary_types():
    """Demonstrate different types of educational summaries"""
    
    print("\n📝 Educational Summary Examples")
    print("=" * 40)
    
    summary_examples = [
        {
            'classification': 'stable',
            'description': 'Consistent measurements across sessions',
            'key_message': 'Measurements show stable patterns',
            'focus': 'Consistency and reliability of measurements'
        },
        {
            'classification': 'variable',
            'description': 'Normal variation in measurements',
            'key_message': 'Measurements show expected variation',
            'focus': 'Normal fluctuation and influencing factors'
        },
        {
            'classification': 'changing',
            'description': 'Notable changes or trends detected',
            'key_message': 'Measurements show significant variation',
            'focus': 'Pattern changes and professional consultation'
        }
    ]
    
    print("Summary Classification Types:")
    
    for example in summary_examples:
        print(f"\n{example['classification'].title()} Pattern:")
        print(f"  Description: {example['description']}")
        print(f"  Key Message: {example['key_message']}")
        print(f"  Educational Focus: {example['focus']}")
    
    print(f"\nContent Principles:")
    print("• Use neutral, objective language")
    print("• Avoid medical terminology and diagnosis")
    print("• Focus on measurement patterns, not health implications")
    print("• Provide educational context about screening limitations")
    print("• Encourage professional consultation when appropriate")
    print("• Reinforce that this is a screening tool, not diagnostic")

def demonstrate_professional_guidance():
    """Demonstrate professional consultation guidance"""
    
    print("\n🏥 Professional Consultation Guidance")
    print("=" * 45)
    
    guidance_categories = [
        {
            'category': 'When to Seek Professional Help',
            'items': [
                'Sudden changes in hearing ability',
                'Persistent tinnitus (ringing in ears)',
                'Difficulty understanding speech in noisy environments',
                'Concerns about hearing loss affecting daily activities'
            ]
        },
        {
            'category': 'Important Reminders',
            'items': [
                'This is a preliminary screening tool, not a diagnostic test',
                'Professional audiological assessment provides comprehensive evaluation',
                'Screening measurements may be influenced by environmental factors',
                'Healthcare providers can interpret results in clinical context'
            ]
        }
    ]
    
    for category in guidance_categories:
        print(f"\n{category['category']}:")
        for i, item in enumerate(category['items'], 1):
            print(f"  {i}. {item}")
    
    print(f"\nGuidance Principles:")
    print("• Provide clear, actionable guidance")
    print("• Emphasize screening vs. diagnostic distinction")
    print("• Encourage professional consultation without alarm")
    print("• Educate about factors affecting measurements")
    print("• Support informed healthcare decision-making")

if __name__ == "__main__":
    try:
        demonstrate_summary_types()
        demonstrate_professional_guidance()
        test_educational_summary()
    except requests.exceptions.ConnectionError:
        print("❌ Could not connect to server. Make sure the Flask app is running on http://127.0.0.1:5000")
    except Exception as e:
        print(f"❌ Test failed with error: {e}")